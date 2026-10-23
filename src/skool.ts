/**
 * Skool internal-API client (Skool has no public API).
 * Two surfaces, both authenticated with the httpOnly `auth_token` JWT cookie (~365-day lifetime):
 *   - www.skool.com Next.js data routes: /_next/data/{buildId}/{page}.json  (feed, members, calendar, post page)
 *   - api2.skool.com JSON API: comments, labels, search, DMs, and all writes
 * All endpoint literals live in this file so a Skool change is fixed in one place.
 * Verified live against a real community on 2026-09-06 unless a method says otherwise.
 */

export const WWW = "https://www.skool.com";
export const API2 = "https://api2.skool.com";

/** A browser User-Agent is mandatory: AWS WAF in front of Skool 403s library/empty agents. */
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const BUILD_ID_TTL_MS = 30 * 60 * 1000;
/** Waits before each &token= follow-up on the analytics routes; a 404 (result not ready) moves to the next wait. */
const TOKEN_WAITS_MS = [1000, 2000, 4000];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let buildIdCache: { id: string; at: number } | null = null; // per-isolate; fine for a stateless Worker

export class SkoolError extends Error {
  constructor(message: string, public readonly kind: "auth" | "edge" | "notfound" | "ratelimit" | "http" | "parse", public readonly status?: number) {
    super(message);
    this.name = "SkoolError";
  }
}

type Json = Record<string, any>;

export class SkoolClient {
  constructor(private readonly token: string, private readonly profile: string) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      "User-Agent": UA,
      Cookie: `auth_token=${this.token}`,
      Accept: "application/json",
      "Accept-Language": "en-US,en;q=0.9",
      ...extra,
    };
  }

  private async classify(res: Response, where: string, text: string): Promise<never> {
    const snippet = text.slice(0, 300);
    if (res.status === 403 && (/cloudfront/i.test(res.headers.get("via") ?? "") && /<html/i.test(snippet))) {
      throw new SkoolError(`Skool's CDN (CloudFront/WAF) blocked the request before Skool saw it (${where}). Not a token problem.`, "edge", 403);
    }
    if (res.status === 401 || res.status === 403) {
      throw new SkoolError(`Skool refused (HTTP ${res.status} at ${where}) for profile "${this.profile}". Either this profile lacks permission for that action (e.g. admin-only), or its auth_token is expired/wrong — check with skool_whoami: if that fails too, rotate the Worker secret.`, "auth", res.status);
    }
    if (res.status === 404) throw new SkoolError(`Not found: ${where}`, "notfound", 404);
    if (res.status === 429) throw new SkoolError(`Rate limited by Skool at ${where}. Wait and retry.`, "ratelimit", 429);
    throw new SkoolError(`HTTP ${res.status} at ${where}: ${snippet}`, "http", res.status);
  }

  // ---------- transport ----------

  /** Next.js buildId rotates on every Skool deploy; scrape it from any page's __NEXT_DATA__. */
  async buildId(force = false): Promise<string> {
    if (!force && buildIdCache && Date.now() - buildIdCache.at < BUILD_ID_TTL_MS) return buildIdCache.id;
    const res = await fetch(`${WWW}/`, { headers: this.headers({ Accept: "text/html" }), redirect: "follow" });
    const html = await res.text();
    if (!res.ok) await this.classify(res, "buildId", html);
    const m = html.match(/"buildId"\s*:\s*"([^"]+)"/);
    if (!m) throw new SkoolError("Could not find buildId in Skool HTML (logged out, or Skool changed its page shell).", "parse");
    buildIdCache = { id: m[1], at: Date.now() };
    return m[1];
  }

  /** GET /_next/data/{buildId}/{page}.json?params -> pageProps. Retries once with a fresh buildId on 404. */
  async nextData(page: string, params: Record<string, string | number | undefined> = {}): Promise<Json> {
    const attempt = async (bid: string) => {
      const url = new URL(`/_next/data/${bid}/${page}.json`, WWW);
      for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
      const res = await fetch(url, { headers: this.headers(), redirect: "manual" });
      const text = await res.text();
      return { res, text };
    };
    let { res, text } = await attempt(await this.buildId());
    if (res.status === 404) ({ res, text } = await attempt(await this.buildId(true)));
    if (res.status >= 300 && res.status < 400) {
      throw new SkoolError(`Skool redirected ${page} to ${res.headers.get("location")} — either the session for profile "${this.profile}" is not valid for this community, or it is a community this profile has not joined whose feed is not public (only its About page is readable; use skool_community).`, "auth", res.status);
    }
    if (!res.ok) await this.classify(res, `next-data ${page}`, text);
    let data: Json;
    try { data = JSON.parse(text); } catch { throw new SkoolError(`Non-JSON from next-data ${page}`, "parse"); }
    if (data.__N_REDIRECT) throw new SkoolError(`Redirect to ${data.__N_REDIRECT} (session invalid?)`, "auth");
    return data.pageProps ?? data;
  }

  /** api2.skool.com call. api2 speaks snake_case. */
  async api2(path: string, opts: { method?: string; body?: unknown; params?: Record<string, string | number | undefined> } = {}): Promise<Json> {
    const url = new URL(path, API2);
    for (const [k, v] of Object.entries(opts.params ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const headers = this.headers({ Origin: WWW, Referer: `${WWW}/` });
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(url, { method: opts.method ?? "GET", headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
    const text = await res.text();
    if (!res.ok) await this.classify(res, `${opts.method ?? "GET"} ${path}`, text);
    if (!text) return {};
    try { return JSON.parse(text); } catch { return { raw: text }; }
  }

  // ---------- identity / community ----------

  /** GET /self/groups -> the profile's communities. */
  async myGroups(): Promise<Json[]> {
    const d = await this.api2("/self/groups", { params: { limit: 50, prefs: "false" } });
    return d.groups ?? [];
  }

  /**
   * Public group record by slug (no auth needed) — this is the whole About page in one call:
   * lp_description (the long About body), description, prices, member/post/course counts, review
   * rating, owner, join-application questions, and top-level `public` (true = non-members can read
   * the feed). Works for any community, joined or not. See normalize.groupAbout.
   */
  async groupBySlug(slug: string): Promise<Json> {
    const d = await this.api2(`/groups/${encodeURIComponent(slug)}`);
    return d.group ?? d;
  }

  async labels(groupId: string): Promise<Json[]> {
    const d = await this.api2(`/groups/${groupId}/labels`);
    return d.labels ?? [];
  }

  /** Member reviews of a community. Public: works for communities this account has not joined. Verified 2026-09-07. */
  async reviews(groupId: string, limit = 10): Promise<Json[]> {
    const d = await this.api2(`/groups/${groupId}/reviews`, { params: { limit } });
    return d.reviews ?? [];
  }

  // ---------- discovery: communities this account has NOT joined ----------

  /**
   * Skool's public community directory (the skool.com/discovery page), via its Next.js data route.
   * Verified live 2026-09-07 by driving the real filter UI — the param names are NOT what the obvious
   * guesses suggest (`t`/`s`/`page` are silently ignored or 404; it is `ty`/`srt`/`p`), and an invalid
   * value renders Skool's "Oops" error page rather than falling back to the default.
   *
   *   q    free-text search
   *   c    category slug: hobbies | music | money | spirituality | tech | health | sports |
   *        self_improvement | relationships
   *   pr   free | paid | free-trial
   *   ty   private | public
   *   srt  trending | top
   *   lang language name, lowercase ("english", "spanish", … 48 of them)
   *   p    page, 30 results per page
   *
   * Needs no auth (the page renders logged out), but goes out with the session like every other call.
   * pageProps.numGroups is the real match count but saturates at 1000 (~34 pages), so a broad query always
   * reports exactly 1000; pageProps.hasMore is unreliable — judge "more pages" by whether a full 30 came back.
   */
  async discover(opts: { q?: string; category?: string; price?: string; type?: string; sort?: string; language?: string; page?: number } = {}): Promise<Json> {
    return this.nextData("discovery", {
      q: opts.q,
      c: opts.category,
      pr: opts.price,
      ty: opts.type,
      srt: opts.sort,
      lang: opts.language,
      p: opts.page ?? 1,
    });
  }

  // ---------- posts ----------

  /** Feed page. sort: newest-cm (recent activity, default) | newest (created). label = category id. */
  async feed(slug: string, opts: { page?: number; sort?: string; label?: string } = {}): Promise<Json> {
    return this.nextData(slug, { group: slug, p: opts.page ?? 1, s: opts.sort ?? "newest-cm", c: opts.label });
  }

  /** Post page by slug ("name"). pageProps.postTree.post; comments are NOT included here (children is empty). */
  async postPage(slug: string, postName: string): Promise<Json> {
    const pp = await this.nextData(`${slug}/${postName}`, { group: slug, p: postName });
    const tree = pp.postTree ?? pp.postTrees?.[0];
    if (!tree?.post) throw new SkoolError(`Post "${postName}" not found in ${slug}.`, "notfound", 404);
    return tree;
  }

  /**
   * api2 GET /posts/{postId}/comments?group-id= -> post_tree.children (each child: {post:{..., user}}).
   * FIRST PAGE ONLY: Skool returns 10 top-level threads by default. Anything that must see every comment
   * uses commentsPage() (through readCommentsPage in comments.ts), which pages with Skool's `last` cursor.
   */
  async comments(groupId: string, postId: string): Promise<Json[]> {
    const d = await this.api2(`/posts/${postId}/comments`, { params: { "group-id": groupId } });
    return d.post_tree?.children ?? [];
  }

  /**
   * One page of a post's comment threads, with the cursor Skool returns. Paging semantics and limits are
   * documented in comments.ts (verified live 2026-10-10). `threads` are top-level comments with replies nested;
   * `pinned` is only sent back when requested and the post has pinned comments; `last` is the microsecond
   * cursor to continue from, 0 when there is nothing further in that direction.
   */
  async commentsPage(
    groupId: string,
    postId: string,
    o: { limit: number; createdGt?: number; createdLt?: number; tail?: boolean; pinned?: boolean },
  ): Promise<{ threads: Json[]; pinned: Json[]; last: number }> {
    const d = await this.api2(`/posts/${postId}/comments`, {
      params: {
        "group-id": groupId,
        limit: o.limit,
        "created-gt": o.createdGt,
        "created-lt": o.createdLt,
        tail: o.tail ? 1 : undefined,
        pinned: o.pinned ? 1 : undefined,
      },
    });
    return { threads: d.post_tree?.children ?? [], pinned: d.pinned_post_tree?.children ?? [], last: Number(d.last ?? 0) };
  }

  /**
   * Create a top-level post. Shape mirrors what the web app sends (post_type "generic" is what
   * Skool returns for every feed post). label_id top-level is the field seen on read; LIVE-TEST BEFORE TRUSTING.
   */
  async createPost(groupId: string, p: { title: string; content: string; labelId?: string; pollId?: string; attachments?: string[] }): Promise<Json> {
    const body: Json = {
      post_type: "generic",
      group_id: groupId,
      metadata: { title: p.title, content: p.content, attachments: (p.attachments ?? []).join(","), action: 0, video_ids: "" },
    };
    if (p.labelId) { body.label_id = p.labelId; body.metadata.labels = p.labelId; }
    // A poll is a separate object referenced by the post: create it first, then pass its id here.
    if (p.pollId) body.metadata.poll = p.pollId;
    return this.api2("/posts", { method: "POST", body, params: { notify: "false", follow: "true" } });
  }

  /** Comment on a post (verified upstream 2026-06; parent_id = post id for a top-level comment, or a comment id for a reply). */
  async createComment(groupId: string, rootPostId: string, content: string, parentId?: string, attachments?: string[]): Promise<Json> {
    const body = {
      post_type: "comment",
      group_id: groupId,
      root_id: rootPostId,
      parent_id: parentId ?? rootPostId,
      metadata: { title: "", content, attachments: (attachments ?? []).join(","), action: 0, video_ids: "" },
    };
    return this.api2("/posts", { method: "POST", body, params: { follow: "false" } });
  }

  /**
   * Edit a published post or comment you own. The route is `POST /posts/{id}/update` — NOT `PUT /posts/{id}`,
   * which is what the shape looks like from the outside and what an earlier note in this repo claimed.
   *
   * The body is a PARTIAL: Skool writes only the keys present, so omitting `title` leaves the title alone
   * rather than blanking it. That is what makes this safe to call with one field. Verified live 2026-09-08
   * by adding then removing an attachment on a real post — its title and 2,038-character body came back
   * byte-identical.
   *
   * Editing does NOT notify anyone, unlike creating. Skool also accepts `labels`, `attachments`,
   * `video_links`, `video_ids`, `poll` and `delete_poll` here; only title and content are exposed, because
   * the rest either have no current use or (delete_poll) destroy votes irreversibly.
   */
  async updatePost(postId: string, p: { title?: string; content?: string }): Promise<Json> {
    const body: Json = {};
    if (p.title !== undefined) body.title = p.title;
    if (p.content !== undefined) body.content = p.content;
    if (!Object.keys(body).length) throw new SkoolError("Nothing to edit: pass title, content, or both.", "http");
    return this.api2(`/posts/${postId}/update`, { method: "POST", body });
  }

  /** Delete a post or comment you own (used to clean up test posts). Unverified live. */
  async deletePost(postId: string): Promise<Json> {
    return this.api2(`/posts/${postId}`, { method: "DELETE" });
  }

  // ---------- members ----------

  /** Members directory page (30 per page). Admin sessions also see email. */
  async members(slug: string, page = 1): Promise<Json> {
    return this.nextData(`${slug}/-/members`, { group: slug, p: page });
  }

  /** Pending join requests: the members page with t=pending (verified 2026-09-06). Each user has role "pending" and member.metadata.survey with the application answers. */
  async pendingMembers(slug: string, page = 1): Promise<Json> {
    return this.nextData(`${slug}/-/members`, { group: slug, t: "pending", p: page });
  }

  /**
   * Change a membership's role. Taken from Skool's own web client (apiClient.updateMemberRole, 2026-09-06):
   * POST /members/{membershipId}/role  body {"new": role}. Approve = "member", decline = "declined".
   * Other roles Skool's client knows: group-admin, group-moderator, banned, pending, payment-pending.
   * membershipId is member.id (NOT the user id) — returned as membershipId by pendingMembers/list_members.
   */
  async setMemberRole(membershipId: string, role: "member" | "declined" | "banned" | "group-moderator" | "group-admin"): Promise<Json> {
    return this.api2(`/members/${membershipId}/role`, { method: "POST", body: { new: role } });
  }

  /**
   * One page (30 rows) of the ADMIN members list — the same next-data route as members(), with Skool's filters.
   * Verified live 2026-10-10:
   *   t        tab: omitted = Active, or cancelling | churned | banned (pending is skool_pending_members).
   *   monthly / annual / oneTime / trials / free  "true" to filter by billing; several together are OR-ed.
   *            Ignored on the churned tab (it returns every churned member regardless).
   *   tiers    tier name, e.g. "premium".  levels  exact level number.
   * Rows come newest join first ("-memberapprovedat", the only sort that works: ascending answers HTTP 500), except
   * the churned tab, which is newest departure first. `total` on the Active tab EXCLUDES admin accounts, yet the admin
   * rows are still in the list (role "group-admin") — e.g. total 43 with 44 rows.
   * Each tabChips[].activeLabel ("Churned 4") is only right for the tab being read; the other chips say 0.
   */
  async memberList(slug: string, opts: { tab?: "cancelling" | "churned" | "banned"; page?: number; filters?: Record<string, string> } = {}): Promise<Json> {
    return this.nextData(`${slug}/-/members`, { group: slug, t: opts.tab, p: opts.page ?? 1, ...opts.filters });
  }

  // ---------- analytics (admin only; non-admins get HTTP 401) ----------

  /**
   * The Dashboard tab's "Active members" chart and "Daily activity" heatmap: GET /groups/{id}/admin-metrics.
   * Query names from Skool's client (getGroupAdminMetrics {timeRange, activeMembersTerm}). Only range=30d works —
   * "90d" and "7d" are HTTP 400 "unsupported time range". `amt` changes only active_members (daily | weekly | monthly).
   * Returns total_members and active_members as 30-point series NEWEST FIRST ({value, time}), latest_active_members
   * (the monthly figure whatever amt is), and daily_activities {start_date, end_date, counts[]} for the past year.
   * Verified live 2026-10-10.
   */
  async adminMetrics(groupId: string, amt: "daily" | "weekly" | "monthly"): Promise<Json> {
    return this.api2(`/groups/${groupId}/admin-metrics`, { params: { range: "30d", amt } });
  }

  /**
   * Skool's analytics routes answer in one of two ways: the data at once, or only {"token": "..."} while the result is
   * computed — then the same call again with &token= returns it. Tokens expire within minutes ("token data not found"),
   * so the second call goes out immediately. A few rounds are allowed in case Skool hands back another token.
   * Verified live 2026-10-10 for every chart and both overview routes.
   * Since 2026-10-23 the &token= call answers HTTP 404 while the result is still being computed (signups_by_source
   * did so on an immediate follow-up, and returned the data a few seconds later), so each follow-up waits first and
   * a 404 is retried after a longer wait. Every retry is a Worker subrequest: keep TOKEN_WAITS_MS short.
   */
  private async tokenized(path: string, params: Record<string, string> = {}): Promise<Json> {
    let d = await this.api2(path, { params });
    for (let i = 0; i < 3 && typeof d.token === "string" && Object.keys(d).length === 1; i++) {
      const token = d.token;
      for (let attempt = 0; ; attempt++) {
        await sleep(TOKEN_WAITS_MS[attempt]);
        try {
          d = await this.api2(path, { params: { ...params, token } });
          break;
        } catch (e) {
          if (!(e instanceof SkoolError && e.kind === "notfound")) throw e;
          if (attempt === TOKEN_WAITS_MS.length - 1) {
            throw new SkoolError(`Skool had no result for ${path} after ${TOKEN_WAITS_MS.reduce((a, b) => a + b, 0) / 1000}s (token follow-up kept answering 404).`, "notfound", 404);
          }
        }
      }
    }
    if (typeof d.token === "string" && Object.keys(d).length === 1) throw new SkoolError(`Skool kept answering ${path} with a token and no data.`, "http");
    return d;
  }

  /**
   * One analytics chart: GET /groups/{id}/analytics-v2?chart=<name>. All 16 names in Skool's client exist; on the
   * Hobby plan mrr_unit, members_cohorts and retention_cohorts answer HTTP 400 "not_allowed_for_hobby_plan".
   * No date parameter: the by-day / by-source charts are the last 30 days, the monthly ones span the community's life.
   * Money is in DOLLARS here (mrr 30 = $30), unlike analyticsOverview. Returns data.chart_data.items.
   */
  async analyticsChart(groupId: string, chart: string): Promise<Json[] | null> {
    const d = await this.tokenized(`/groups/${groupId}/analytics-v2`, { chart });
    return d.data?.chart_data?.items ?? null;
  }

  /** Dashboard tab headline: {num_members, mrr, retention}. mrr is in CENTS here (2700 = $27.00). Two-step token. */
  async analyticsOverview(groupId: string): Promise<Json> {
    return (await this.tokenized(`/groups/${groupId}/analytics-overview-v2`)).data ?? {};
  }

  /** Growth tab headline, last 30 days: {num_visitors, num_signups, new_mrr}. new_mrr is in DOLLARS. Two-step token. */
  async analyticsGrowthOverview(groupId: string): Promise<Json> {
    return (await this.tokenized(`/groups/${groupId}/analytics-growth-overview-v2`)).data ?? {};
  }

  /**
   * ONE member's progress in every course, as an admin sees it in that member's settings (Skool's client:
   * getMemberCoursePermissions {groupID, memberID: member.id, progression: true}). Returns courses[] (snake_case);
   * with progression=true each course's metadata carries user_completed (a COUNT of lessons, not which ones) next to
   * num_modules. Drafts come back without user_completed. `member` is the MEMBERSHIP id (member.id) — a user id is
   * HTTP 500 — and there is no bulk form: an empty, comma-joined or `members=` value is HTTP 400 "invalid member ID".
   * Admin-only. Verified 2026-10-11 against three members' own classroom views.
   */
  async memberCourseProgress(groupId: string, membershipId: string): Promise<Json[]> {
    const d = await this.api2(`/groups/${groupId}/member-course-permissions`, { params: { progression: "true", member: membershipId } });
    return d.courses ?? [];
  }

  /** POST /search/users {group_id, query, limit} -> users[] (snake_case). */
  async searchMembers(groupId: string, query: string, limit = 20): Promise<Json[]> {
    const d = await this.api2("/search/users", { method: "POST", body: { group_id: groupId, query, limit } });
    return d.users ?? [];
  }

  // ---------- calendar ----------

  async calendar(slug: string): Promise<Json> {
    return this.nextData(`${slug}/calendar`, { group: slug });
  }

  // ---------- direct messages (endpoints verified upstream 2026-06; this account had no DMs to verify against on 2026-09-06) ----------

  async conversations(limit = 30, unreadOnly = false): Promise<Json[]> {
    const d = await this.api2("/self/chat-channels", { params: { offset: 0, limit, last: "true", "unread-only": String(unreadOnly) } });
    return d.channels ?? [];
  }

  /** `before` = how many messages back from the latest. */
  async messages(channelId: string, before = 30): Promise<Json[]> {
    const d = await this.api2(`/channels/${channelId}/messages`, { params: { before } });
    return d.messages ?? [];
  }

  /**
   * Send a DM. `attachments` is an ARRAY of file ids here — note the difference from posts and comments,
   * where the same concept is a comma-joined STRING in metadata.attachments. Same file ids either way
   * (see createGifFile); only the encoding differs, so passing one shape where the other belongs fails
   * silently rather than erroring.
   */
  async sendMessage(channelId: string, content: string, attachments: string[] = []): Promise<Json> {
    return this.api2(`/channels/${channelId}/messages`, { method: "POST", body: { content, attachments }, params: { ct: "wdm" } });
  }

  async markRead(channelId: string): Promise<Json> {
    return this.api2(`/channels/${channelId}/read`, { method: "POST" });
  }

  async startChat(groupId: string, userId: string): Promise<Json> {
    return this.api2(`/users/${userId}/chat-request`, { method: "POST", params: { g: groupId } });
  }

  // ---------- classroom / courses ----------

  /** Classroom index -> pageProps.allCourses. */
  async classroom(slug: string): Promise<Json[]> {
    const pp = await this.nextData(`${slug}/classroom`, { group: slug });
    return pp.allCourses ?? [];
  }

  /**
   * A course page. The route 307s to ?md=<firstModuleId>, so with no module id this follows the redirect to
   * discover the first lesson. Returns { course, video, moduleId }.
   * pageProps.course is the section/lesson tree; pageProps.video belongs to the SELECTED module only.
   *
   * Two edges verified 2026-09-23: a course with no lessons yet does NOT redirect — it answers 200 with the course
   * and `children: null`, so moduleId comes back undefined. And `md` must be a LESSON id: a section's or the
   * course's own id gets HTTP 400, not a fallback (see unitPage in tools.ts).
   */
  async coursePage(slug: string, courseSlug: string, moduleId?: string): Promise<Json> {
    let md = moduleId;
    if (!md) {
      const probe = await this.nextDataRaw(`${slug}/classroom/${courseSlug}`, { group: slug });
      const loc = probe.__N_REDIRECT ?? "";
      md = new URL(loc, WWW).searchParams.get("md") ?? undefined;
      if (!md) {
        if (probe.pageProps?.course) return { course: probe.pageProps.course, video: undefined, moduleId: undefined };
        throw new SkoolError(`Could not resolve a first module for course "${courseSlug}".`, "notfound", 404);
      }
    }
    const pp = await this.nextData(`${slug}/classroom/${courseSlug}`, { group: slug, md });
    if (!pp.course) throw new SkoolError(`Course "${courseSlug}" not found in ${slug}.`, "notfound", 404);
    return { course: pp.course, video: pp.video, moduleId: md };
  }

  /**
   * Like nextData but surfaces the redirect instead of throwing, so it can be inspected.
   * Next.js signals this route's redirect INSIDE a 200 JSON body as pageProps.__N_REDIRECT, not as an
   * HTTP 3xx — both forms are handled here because the course route relies on it.
   */
  private async nextDataRaw(page: string, params: Record<string, string | number | undefined> = {}): Promise<Json> {
    const url = new URL(`/_next/data/${await this.buildId()}/${page}.json`, WWW);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    const res = await fetch(url, { headers: this.headers(), redirect: "manual" });
    const text = await res.text();
    if (res.status >= 300 && res.status < 400) return { __N_REDIRECT: res.headers.get("location") ?? "" };
    let data: Json = {};
    try { data = JSON.parse(text); } catch { return {}; }
    const redirect = data.__N_REDIRECT ?? data.pageProps?.__N_REDIRECT;
    return redirect ? { __N_REDIRECT: redirect } : data;
  }

  /**
   * Create one classroom unit — Skool calls a course, a section and a lesson all a "course", told apart by
   * unit_type: "course" (top level), "set" (section/folder) or "module" (lesson). Shape from Skool's own web
   * client (apiClient.createCourse), verified live 2026-09-23. Unlike updateCourse, the fields sit under
   * `metadata`. Returns the new unit, snake_case, including `id` and `name` (a course's URL slug).
   *
   * Always created as a DRAFT (state 1): members cannot see it until skool_set_published. Skool's own editor
   * creates new lessons published (state 2); this is deliberately stricter. user_id is filled in by Skool from
   * the session, so it is not sent. root_id is the top-level course id and parent_id the direct parent; both
   * are omitted for a course. Titles are capped at 50 characters (HTTP 422 "Title is too long" above that).
   */
  async createCourseUnit(groupId: string, u: { unitType: "course" | "set" | "module"; title: string; rootId?: string; parentId?: string; metadata?: Json }): Promise<Json> {
    const body: Json = { group_id: groupId, unit_type: u.unitType, state: 1, metadata: { title: u.title, ...u.metadata } };
    if (u.rootId) body.root_id = u.rootId;
    if (u.parentId) body.parent_id = u.parentId;
    return this.api2("/courses", { method: "POST", body });
  }

  /**
   * Update one classroom unit. The snake_case body sits at the TOP level here (createCourse nests the same fields
   * under `metadata`): title, desc, video_link, video_len_ms, video_thumbnail, video_stream, video_id, transcript,
   * resources + update_resources, cover_image, privacy, min_access_level, …
   *
   * The body is a PARTIAL, like POST /posts/{id}/update: an omitted key is left alone. Verified live 2026-09-23 —
   * a title-only PUT left the lesson's body, YouTube video and resources byte-identical. Skool's own editor relies
   * on this too: renaming a folder sends only `title`, and it sends `resources` only when they changed (as an array,
   * with update_resources: true). Returns the saved unit, snake_case, so no re-read is needed.
   * A 422 (e.g. title over 50 characters) rejects the whole body — nothing is written.
   * Publish state is a separate route (setCourseState) and is never touched here.
   */
  async updateCourse(unitId: string, body: Json): Promise<Json> {
    return this.api2(`/courses/${unitId}`, { method: "PUT", body });
  }

  /**
   * Publish or unpublish one unit: PUT /courses/{id}/state?state=published|draft. The value is the WORD, as
   * Skool's client sends it, not the number the unit reports back (2 = published, 1 = draft). Verified live
   * 2026-09-23. It does not cascade: a published lesson inside a draft section or course stays invisible to
   * members, who see a unit only when it and every unit above it are published. Skool's classroom editor has no
   * "notify members" option, and publishing a test lesson produced no notification — but that test could only use
   * a unit members could not see.
   */
  async setCourseState(unitId: string, published: boolean): Promise<Json> {
    return this.api2(`/courses/${unitId}/state`, { method: "PUT", params: { state: published ? "published" : "draft" } });
  }

  /**
   * Skool's video-link lookup (POST /video-meta?url=&width=), the call its editor makes before saving a lesson's
   * video. Returns { url, provider, video_id, thumbnail, len_ms, title } — provider 1 = YouTube. An unknown video
   * is HTTP 400 "failed to retrieve video metadata", so this doubles as link validation. Skool does NOT fill in
   * length or thumbnail itself when a link is saved; the client stores what this returns. Verified 2026-09-23.
   */
  async videoMeta(url: string): Promise<Json> {
    return this.api2("/video-meta", { method: "POST", params: { url, width: 1280 } });
  }

  /**
   * The largest YouTube thumbnail that exists. /video-meta hands back hqdefault; Skool's editor then HEAD-probes
   * i.ytimg.com from the largest size down and stores the first that answers, which is how a lesson ends up with
   * maxresdefault. Same order here. Costs up to five subrequests.
   */
  static async youtubeThumbnail(videoId: string, fallback: string): Promise<string> {
    for (const size of ["maxresdefault", "sddefault", "hqdefault", "mqdefault", "default"]) {
      const u = `https://i.ytimg.com/vi/${videoId}/${size}.jpg`;
      try { if ((await fetch(u, { method: "HEAD", headers: { "User-Agent": UA } })).ok) return u; } catch { /* try the next size */ }
    }
    return fallback;
  }

  /** Depth-first search of a course tree for a node id. */
  static findUnit(node: Json, id: string): Json | null {
    for (const child of node.children ?? []) {
      const u = child.course ?? child;
      if (u.id === id) return u;
      const hit = SkoolClient.findUnit(child, id);
      if (hit) return hit;
    }
    return null;
  }

  /** Like findUnit, but returns every unit from the top of the tree down to the match, or null. */
  static findPath(node: Json, id: string): Json[] | null {
    for (const child of node.children ?? []) {
      const u = child.course ?? child;
      if (u.id === id) return [u];
      const sub = SkoolClient.findPath(child, id);
      if (sub) return [u, ...sub];
    }
    return null;
  }

  // ---------- video captions (Mux) ----------

  /**
   * Skool hosts lesson video on Mux and auto-generates captions; Skool's own `transcript` field is usually
   * empty. There is NO single-file transcript URL: /text/{trackId}.vtt exists but needs Mux's AssetTrack id,
   * which Skool does not expose (api2 /videos/{id} returns only duration and status — checked 2026-09-07).
   * So the transcript must be assembled from 30-second WebVTT segments.
   *
   * Costs 2 subrequests. The two manifest fetches REQUIRE a Referer of https://www.skool.com/ (the playback
   * token carries a playback_restriction_id and returns 403 without it); the segment URLs it returns are
   * individually pre-signed and need no headers at all.
   */
  async captionSegments(playbackId: string, playbackToken: string): Promise<string[] | null> {
    const h = { "User-Agent": UA, Referer: `${WWW}/` };
    const masterRes = await fetch(`https://stream.mux.com/${playbackId}.m3u8?token=${playbackToken}`, { headers: h });
    if (!masterRes.ok) throw new SkoolError(`Mux refused the video manifest (HTTP ${masterRes.status}). The playback token may have expired — re-read the lesson to get a fresh one.`, "auth", masterRes.status);
    const master = await masterRes.text();
    const uri = master.match(/TYPE=SUBTITLES[^\n]*URI="([^"]+)"/)?.[1];
    if (!uri) return null; // no caption track on this video
    const playlist = await (await fetch(uri, { headers: h })).text();
    return playlist.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((u) => new URL(u, uri).toString());
  }

  /** Fetch a window of caption segments in parallel. Pre-signed, so no headers needed. */
  async captionWindow(segments: string[]): Promise<string[]> {
    return Promise.all(segments.map(async (u) => (await fetch(u)).text()));
  }
  // ---------- polls ----------

  /**
   * Create a poll, then attach its id to a post via createPost({ pollId }) — a poll is a separate object
   * and is invisible until a post references it. `options` is a plain array of option strings.
   * Request shape `{ group_id, options }` and response shape `{ poll_id }` (NOT `.id` or `.poll.id`)
   * both confirmed live 2026-09-08 by capturing Skool's own web client's real network request/response.
   */
  async createPoll(groupId: string, options: string[]): Promise<Json> {
    return this.api2("/polls", { method: "POST", body: { group_id: groupId, options } });
  }

  /**
   * Delete a poll object. Used only to clean up a poll that was created but never got a post (see skool_create_poll);
   * `DELETE /polls/{id}` is taken from Skool's own web client (SKOOL-ENDPOINTS.md) and NOT yet exercised live.
   * Never call it on a poll a post references: it destroys the votes cast on it.
   */
  async deletePoll(pollId: string): Promise<Json> {
    return this.api2(`/polls/${pollId}`, { method: "DELETE" });
  }

  /** Who voted for one option. Results themselves ride along on the post as metadata.pollData. */
  async pollVoters(pollId: string, optionIdx: number, limit = 30, offset = 0): Promise<Json> {
    return this.api2(`/polls/${pollId}/option-users`, { params: { idx: optionIdx, offset, limit } });
  }

  // ---------- likes ----------

  /**
   * Like / unlike a post OR a comment — Skool models a comment as a post, so the same endpoint and the
   * same id work for both. `newVote` is "up" to like and "" to unlike; `oldVote` is the CURRENT state.
   * Verified live 2026-09-08 on both a post and a comment (count round-tripped 4 -> 5 -> 4).
   *
   * Skool uses `old` to compute the delta, so passing a stale `oldVote` can skew the count — always read
   * the current value (metadata.my_vote) first rather than assuming. voteState() does exactly that.
   * Liking in a tight loop earns HTTP 429 ("Liking too fast"), so keep it at human pace.
   */
  async votePost(postId: string, oldVote: string, newVote: "up" | ""): Promise<Json> {
    return this.api2(`/posts/${postId}/vote`, { method: "PUT", body: { old: oldVote, new: newVote } });
  }

  /**
   * Current like state of a post or comment for THIS account: { myVote, upvotes }.
   * The field is `my_vote` on api2 and `myVote` on the Next.js pages, and it is ABSENT rather than ""
   * when the account has not voted — normalized to "" here.
   */
  async voteState(postId: string, groupId: string): Promise<{ myVote: string; upvotes: number }> {
    const raw = await this.postById(postId, groupId);
    const m = (raw.post ?? raw)?.metadata ?? {};
    return { myVote: (m.my_vote ?? m.myVote ?? "") as string, upvotes: Number(m.upvotes ?? 0) };
  }

  /**
   * Members who liked a post or comment. Rows are FLAT user records (no nested `.user`) and, for an admin
   * session, carry `email` — normalize.author drops it.
   *
   * Uses /vote-users, NOT /upvote-users. Both exist and return the same users, but /upvote-users hard-caps
   * `limit` at 10 — 11 and above are rejected outright with HTTP 400 "invalid limit: N", not clamped — and
   * it takes no cursor, so likers past the tenth are simply unreachable. /vote-users accepts a normal limit
   * plus a cursor, and adds the true total. Verified live 2026-09-08: limit 11 and 30 both 400 on
   * /upvote-users, while /vote-users returned all 9 likers at limit 30 with total_upvote_users.
   * Do not "simplify" this back to the more obviously-named endpoint.
   */
  async voteUsers(postId: string, limit = 30, cursor?: string): Promise<{ users: Json[]; hasMore: boolean; total: number; cursor: string | null }> {
    const d = await this.api2(`/posts/${postId}/vote-users`, { params: { limit, tab: "upvotes", cursor } });
    return {
      users: d.users ?? [],
      hasMore: !!(d.has_more ?? d.hasMore),
      total: Number(d.total_upvote_users ?? d.totalUpvoteUsers ?? (d.users ?? []).length),
      cursor: d.cursor ?? d.next_cursor ?? null,
    };
  }

  // ---------- GIFs ----------

  /**
   * GIF search. Skool does not proxy this: its web client calls Giphy directly with a public client key
   * shipped in the page, then stores only a REFERENCE to the chosen GIF (see createGifFile). This is the
   * same call its picker makes — rating pg-13 when there is a query, g for the default listing.
   * The key is overridable via the GIPHY_KEY secret; the default is the one Skool's own page ships.
   */
  static readonly GIPHY_DEFAULT_KEY = "eTYZVZGLxZxgS3w15EgAx6IgBwalxCoz";

  /** Static: the Giphy call carries no Skool session, so searching must not require a configured profile. */
  static async searchGifs(query: string, limit = 12, offset = 0, apiKey?: string): Promise<Json[]> {
    const url = new URL("https://api.giphy.com/v1/gifs/search");
    url.searchParams.set("api_key", apiKey || SkoolClient.GIPHY_DEFAULT_KEY);
    url.searchParams.set("q", query || "lol");
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("rating", query ? "pg-13" : "g");
    url.searchParams.set("language", "en");
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    const text = await res.text();
    if (!res.ok) throw new SkoolError(`Giphy refused the search (HTTP ${res.status}): ${text.slice(0, 200)}`, "http", res.status);
    let j: Json;
    try { j = JSON.parse(text); } catch { throw new SkoolError("Non-JSON from Giphy search", "parse"); }
    return j.data ?? [];
  }

  /**
   * Register a Giphy GIF as a Skool file and return its file id, for use in a post/comment's
   * `attachments`. No bytes are uploaded — Skool stores the external Giphy URLs and derives its own
   * thumbnail. Verified live 2026-09-08.
   *
   * Note: Skool garbage-collects a file that is not referenced by any post, so create it as part of
   * publishing rather than ahead of time — an id held over from an earlier call may already be gone.
   */
  async createGifFile(fileName: string, mdUrl: string, smUrl?: string): Promise<string> {
    const d = await this.api2("/files", {
      method: "POST",
      body: {
        file_name: fileName.endsWith(".gif") ? fileName : `${fileName}.gif`,
        content_type: "image/gif",
        content_length: 0,
        content_disposition: "",
        ref: "",
        owner_id: "",
        external_src: mdUrl,
        external_src_small: smUrl || mdUrl,
        large_thumbnail: false,
      },
    });
    const id = d.file?.id ?? d.id;
    if (!id) throw new SkoolError("Skool did not return a file id for the GIF; nothing was posted.", "http");
    return id as string;
  }

  // ---------- activity: notifications, search, leaderboard, rules, levels ----------

  /**
   * Cross-community notification feed for this account.
   * The list-type param is `type` — `lt` and `list_type` both return HTTP 400 "invalid list type".
   * Returns { messages, has_more, cursor }; each message has metadata.data as a JSON *string*.
   */
  async notifications(limit = 20, cursor?: string): Promise<Json> {
    // Hard cap: Skool 400s ("invalid limit") above 30 here, unlike the 50 most list endpoints allow.
    return this.api2("/self/notifications", { params: { type: "all", limit, cursor } });
  }

  /**
   * In-community post search. The `/-/` path segment is required: without it the q param is silently
   * ignored and Skool returns the unfiltered feed, which looks like a search that matched everything.
   * This is the only way to reach posts older than the recent feed.
   */
  async searchPosts(slug: string, query: string, page = 1): Promise<Json> {
    return this.nextData(`${slug}/-/search`, { group: slug, q: query, p: page });
  }

  /** Leaderboards page: all-time / 30-day / 7-day top members plus the group's level distribution. */
  async leaderboards(slug: string): Promise<Json> {
    return this.nextData(`${slug}/-/leaderboards`, { group: slug });
  }

  async rules(groupId: string): Promise<Json[]> {
    const d = await this.api2(`/groups/${groupId}/rules`);
    return d.rules ?? [];
  }

  async levels(groupId: string): Promise<Json[]> {
    const d = await this.api2(`/groups/${groupId}/levels`);
    return d.levels ?? [];
  }

  /**
   * One post or comment by id, directly. Verified 2026-09-07 — this removes the old limitation that a
   * postId only resolved if it appeared within the first few feed pages.
   */
  async postById(postId: string, groupId: string): Promise<Json> {
    return this.api2(`/posts/${postId}`, { params: { "group-id": groupId } });
  }

  // ---------- discovery ----------

  /** Raw authenticated GET against skool.com hosts only, for endpoint discovery from chat. */
  async rawGet(url: string): Promise<{ status: number; body: string }> {
    const u = new URL(url);
    if (!/(^|\.)skool\.com$/.test(u.hostname)) throw new SkoolError("rawGet only allows *.skool.com URLs", "http");
    const res = await fetch(u, { headers: this.headers({ Origin: WWW, Referer: `${WWW}/` }), redirect: "manual" });
    const body = await res.text();
    return { status: res.status, body: body.slice(0, 20000) };
  }
}

/** WebVTT segments -> plain text. Drops cue numbers, timings and tags, and collapses the duplicate cues
 *  that HLS repeats across segment boundaries (consecutive only — a genuinely repeated phrase is kept). */
export function vttToText(parts: string[]): string {
  const lines: string[] = [];
  for (const vtt of parts) {
    for (const raw of vtt.split("\n")) {
      const t = raw.trim();
      if (!t || t === "WEBVTT" || t.includes("-->") || /^\d+$/.test(t)) continue;
      if (t.startsWith("X-TIMESTAMP-MAP") || t.startsWith("NOTE") || t.startsWith("STYLE") || t.startsWith("REGION")) continue;
      const clean = t.replace(/<[^>]+>/g, "").trim();
      if (clean && clean !== lines[lines.length - 1]) lines.push(clean);
    }
  }
  return lines.join(" ").replace(/\s+/g, " ").trim();
}
