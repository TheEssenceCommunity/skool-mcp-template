/**
 * Daily health check (Cloudflare cron trigger) + on-demand GET /healthcheck (x-mcp-key required).
 * For every profile with a token it exercises EVERY read endpoint the tools depend on, plus the token expiry.
 * Writes (post, comment, DM send, approve) are deliberately not exercised: each would publish something
 * visible to members every day. A failing write tool in chat remains the signal for those.
 * On any failure, or a token within TOKEN_WARN_DAYS of expiry, one Telegram message is sent.
 *
 * RULE: every new tool or endpoint gets a check here in the same change — the daily run is how a silent Skool change
 * gets noticed, and a tool with no check can break unseen.
 *
 * Shared checks — classroom (course index, one outline, the /video-meta lookup) and analytics (admin-metrics, the
 * two-step token routes, the member-list tabs and billing filters skool_analytics reads) — run for the FIRST
 * configured profile only. The whole check is ONE Worker invocation, capped at 50 subrequests on the free plan.
 * Budget with three profiles: buildId 1 + per-profile 12 / 10 / 10 (admin / member / member) + classroom 4 + analytics 8
 * + comment paging 2 + course progress 1 = 48, plus 1 Telegram message on failure = 49. One profile: about 28. (KV reads are not external
 * subrequests.) Before adding a check, recount; past ~48 split the run in two
 * (a second cron entry and a `part` switch) rather than dropping coverage.
 */
import { type Env, type Profile, profilesOf, tokenFor } from "./env";
import { SkoolClient } from "./skool";
import { activityDays, memberRec } from "./analytics";
import { lessonVideoCounts } from "./normalize";
import { probeNewest, probeContinuation, type PagingProbe } from "./comments";
import { latestProgress, PROGRESS_MAX_AGE_HOURS } from "./progress";

const TOKEN_WARN_DAYS = 30;
/** A video that has been on YouTube since 2005 ("Me at the zoo"): a stable target for the /video-meta check. */
const PROBE_YOUTUBE_URL = "https://www.youtube.com/watch?v=jNQXAC9IVRw";

export interface Check { name: string; ok: boolean; detail: string; ms: number }
export interface ProfileHealth { profile: Profile; ok: boolean; tokenExpires: string | null; daysLeft: number | null; checks: Check[] }

function jwtExpiry(token: string): Date | null {
  try {
    const payload = token.split(".")[1];
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "="));
    const exp = JSON.parse(json).exp;
    return typeof exp === "number" ? new Date(exp * 1000) : null;
  } catch { return null; }
}

/** Run one check; a thrown error or a returned string starting with "FAIL" marks it failed. */
async function run(name: string, fn: () => Promise<string>): Promise<Check> {
  const t0 = Date.now();
  try {
    const detail = await fn();
    return { name, ok: !detail.startsWith("FAIL"), detail, ms: Date.now() - t0 };
  } catch (e) {
    return { name, ok: false, detail: `FAIL ${(e as Error).message}`, ms: Date.now() - t0 };
  }
}

export async function checkProfile(profile: Profile, env: Env, withShared = false): Promise<ProfileHealth> {
  const out: ProfileHealth = { profile, ok: true, tokenExpires: null, daysLeft: null, checks: [] };
  let token: string;
  try { token = tokenFor(profile, env); } catch (e) { out.ok = false; out.checks.push({ name: "token", ok: false, detail: (e as Error).message, ms: 0 }); return out; }

  const exp = jwtExpiry(token);
  if (exp) {
    out.tokenExpires = exp.toISOString().slice(0, 10);
    out.daysLeft = Math.floor((exp.getTime() - Date.now()) / 86_400_000);
  }
  out.checks.push({ name: "token-expiry", ok: out.daysLeft === null || out.daysLeft >= TOKEN_WARN_DAYS, detail: exp ? `expires ${out.tokenExpires} (${out.daysLeft} days)` : "could not decode expiry", ms: 0 });

  const c = new SkoolClient(token, profile);
  const slug = env.SKOOL_DEFAULT_SLUG;
  const gid = env.SKOOL_DEFAULT_GROUP_ID;
  let firstPost: { id: string; name: string } | null = null;
  // The post the comment-paging probes read: the busiest on the first feed page, so there is a thread to page through.
  let commentPost: { id: string; counter: number } | null = null;
  let pagingProbe: PagingProbe | null = null;
  let isAdmin: boolean | null = null; // learned from the members page; admin-only checks are skipped when false
  let membersPage: any = null;
  let inbox: any[] | null = null;

  out.checks.push(await run("whoami (api2 /self/groups)", async () => {
    const groups = await c.myGroups();
    return groups.some((g) => g.name === slug) ? `ok (${groups.length} communities)` : `FAIL session valid but not a member of ${slug}`;
  }));
  out.checks.push(await run("community (api2 /groups/{slug})", async () => {
    const g = await c.groupBySlug(slug);
    return g?.id === gid ? `ok (${g.metadata?.total_members} members)` : `FAIL group id mismatch: ${g?.id}`;
  }));
  out.checks.push(await run("feed (next-data /{slug})", async () => {
    const pp = await c.feed(slug, { page: 1 });
    const trees = pp.postTrees ?? [];
    if (!trees.length) return "FAIL feed returned 0 posts";
    const p = trees[0].post;
    if (!p?.id || !p?.name || !p?.metadata) return "FAIL post shape changed (no id/name/metadata)";
    firstPost = { id: p.id, name: p.name };
    // Prefer a post a single 30-thread request reads whole (3..30 comments), so its counter can be reconciled too.
    const counted = trees.map((t: any) => ({ id: t.post?.id as string, counter: Number(t.post?.metadata?.comments ?? 0) })).filter((x: any) => x.id && x.counter > 0);
    const byCount = (a: any, b: any) => b.counter - a.counter;
    commentPost = counted.filter((x: any) => x.counter >= 3 && x.counter <= 30).sort(byCount)[0] ?? counted.sort(byCount)[0] ?? null;
    return `ok (${trees.length} posts, total ${pp.total})`;
  }));
  out.checks.push(await run("post page (next-data /{slug}/{post})", async () => {
    if (!firstPost) return "FAIL skipped: no post from feed";
    const tree = await c.postPage(slug, firstPost.name);
    return tree.post?.id === firstPost.id ? "ok" : "FAIL post page returned a different post";
  }));
  out.checks.push(await run("comments (api2 /posts/{id}/comments)", async () => {
    if (!firstPost) return "FAIL skipped: no post from feed";
    // The paged read the tools use (tail + limit + pinned), on a post that has comments; reconciles the post's counter.
    const target = commentPost ?? { id: firstPost.id, counter: 0 };
    const r = await probeNewest(c, gid, target.id, commentPost ? commentPost.counter : null);
    pagingProbe = r.probe;
    return commentPost || r.detail.startsWith("FAIL") ? r.detail : `${r.detail} — first feed post only: no post on the first page has comments`;
  }));
  out.checks.push(await run("members (next-data /{slug}/-/members)", async () => {
    const pp = await c.members(slug, 1);
    membersPage = pp;
    const users = pp.users ?? [];
    isAdmin = pp.isAdmin === true;
    return users.length && users[0].id && users[0].member ? `ok (${users.length} on page 1 of ${pp.totalPages}${isAdmin ? ", admin" : ", member"})` : "FAIL members shape changed";
  }));
  // Admin-only endpoints (Skool answers 401/404 for ordinary members): skipped for non-admin profiles.
  out.checks.push(await run("labels (api2 /groups/{id}/labels, admin)", async () => {
    if (isAdmin === false) return "ok (skipped: profile is not an admin)";
    const l = await c.labels(gid);
    return l.length ? `ok (${l.length})` : "FAIL no labels returned";
  }));
  out.checks.push(await run("pending (next-data members t=pending, admin)", async () => {
    if (isAdmin === false) return "ok (skipped: profile is not an admin)";
    const pp = await c.pendingMembers(slug, 1);
    return pp.tabName === "pending" ? `ok (${(pp.users ?? []).length} pending)` : `FAIL tabName=${pp.tabName} (param ignored?)`;
  }));
  out.checks.push(await run("search (api2 POST /search/users)", async () => {
    const users = await c.searchMembers(gid, "a", 3);
    return Array.isArray(users) ? `ok (${users.length})` : "FAIL no users array";
  }));
  out.checks.push(await run("calendar (next-data /{slug}/calendar)", async () => {
    const pp = await c.calendar(slug);
    return Array.isArray(pp.events) ? `ok (${pp.events.length} events)` : "FAIL no events array";
  }));
  out.checks.push(await run("dm inbox (api2 /self/chat-channels)", async () => {
    inbox = await c.conversations(5);
    return `ok (${inbox.length} conversations)`;
  }));
  out.checks.push(await run("dm messages (api2 /channels/{id}/messages)", async () => {
    // Reuses the inbox read above rather than listing it again: one subrequest per profile saved.
    if (!inbox) return "FAIL skipped: inbox check failed";
    if (!inbox.length) return "ok (skipped: no conversations yet)";
    const msgs = await c.messages(inbox[0].id, 5);
    return Array.isArray(msgs) ? `ok (${msgs.length} messages)` : "FAIL no messages array";
  }));

  if (withShared) {
    let courseSlug: string | null = null;
    let hasPublishedCourse = false;
    out.checks.push(await run("classroom (next-data /{slug}/classroom)", async () => {
      const courses = await c.classroom(slug);
      if (!courses.length) return "ok (no courses yet — the outline check is skipped)";
      const pick = courses.find((x) => x.state === 2) ?? courses[0];
      if (!pick?.id || !pick?.name || !pick?.metadata) return "FAIL course shape changed (no id/name/metadata)";
      courseSlug = pick.name;
      hasPublishedCourse = courses.some((x) => x.state === 2);
      return `ok (${courses.length} courses)`;
    }));
    out.checks.push(await run("course outline (next-data /{slug}/classroom/{course})", async () => {
      if (!courseSlug) return "ok (skipped: no course in the classroom)";
      const { course } = await c.coursePage(slug, courseSlug);
      const root = course.course ?? course;
      if (!root?.id || root.unitType !== "course") return `FAIL course root shape changed (unitType=${root?.unitType})`;
      const units = (course.children ?? []).map((ch: any) => ch.course ?? ch);
      if (units.some((u: any) => !["set", "module"].includes(u.unitType) || typeof u.state !== "number")) return "FAIL unit shape changed (unitType/state)";
      // Same read, no extra request: the nightly course-progress collection classifies lessons by video kind.
      const vc = lessonVideoCounts(course);
      if (vc.linkedOther["unknown"]) return "FAIL a lesson's video link could not be parsed (video kinds would be miscounted)";
      const other = Object.values(vc.linkedOther).reduce((s, n) => s + n, 0);
      return `ok (${units.length} top-level items; ${vc.lessons} published lessons: ${vc.uploaded} uploaded, ${vc.youtube} YouTube, ${other} other linked, ${vc.noVideo} no video)`;
    }));
    out.checks.push(await run("video lookup (api2 POST /video-meta)", async () => {
      const m = await c.videoMeta(PROBE_YOUTUBE_URL);
      return Number(m.len_ms) > 0 && m.thumbnail ? `ok (${Math.round(Number(m.len_ms) / 1000)}s)` : `FAIL shape changed: ${JSON.stringify(m).slice(0, 120)}`;
    }));
    // Comment paging (skool_get_comments): 2 requests, reusing the thread the per-profile comments check just read.
    out.checks.push(await run("comment paging: cursors (api2 comments created-gt / created-lt, limit 1)", async () => {
      if (!pagingProbe) return "FAIL skipped: the comments check did not produce a probe";
      return probeContinuation(c, gid, pagingProbe);
    }));

    // ---- analytics (skool_analytics). Admin-only routes: skipped, not failed, for a non-admin profile. ----
    const adminOnly = async (fn: () => Promise<string>) => (isAdmin === false ? "ok (skipped: profile is not an admin)" : fn());
    out.checks.push(await run("analytics: member record fields (from the members page above, no request)", () => adminOnly(async () => {
      const users = membersPage?.users ?? [];
      if (!users.length) return "FAIL skipped: members check returned nothing";
      if (typeof membersPage.total !== "number" || typeof membersPage.totalAdmins !== "number") return "FAIL total / totalAdmins missing (the three-count member labels depend on them)";
      const recs = users.map((u: any) => memberRec(u, "active"));
      if (recs.some((r: any) => !r.joinedAt)) return "FAIL member.approvedAt missing (join dates)";
      if (recs.every((r: any) => r.source === null)) return "FAIL metadata.attrComp missing on every member (join sources)";
      return `ok (${recs.length} records, ${recs.filter((r: any) => r.tier === "paid").length} paid on page 1)`;
    })));
    out.checks.push(await run("analytics: active members (api2 admin-metrics)", () => adminOnly(async () => {
      const m = await c.adminMetrics(gid, "daily");
      const a = m.active_members?.[0], t = m.total_members?.[0];
      if (typeof a?.value !== "number" || typeof t?.value !== "number" || !a?.time) return `FAIL series shape changed: ${JSON.stringify(m).slice(0, 120)}`;
      const ad = activityDays(m.daily_activities);
      if (!ad) return "FAIL daily_activities missing";
      if (!ad.trusted) return `FAIL daily-activity dates no longer line up: ${ad.alignment}`;
      return `ok (daily active ${a.value} on ${String(a.time).slice(0, 10)}, ${ad.days.length} activity days aligned)`;
    })));
    out.checks.push(await run("analytics: headline, two-step token (api2 analytics-overview-v2)", () => adminOnly(async () => {
      const o = await c.analyticsOverview(gid);
      return typeof o.num_members === "number" && typeof o.mrr === "number" ? `ok (${o.num_members} members, MRR ${o.mrr} cents)` : `FAIL shape changed: ${JSON.stringify(o).slice(0, 120)}`;
    })));
    out.checks.push(await run("analytics: chart, direct (api2 analytics-v2 chart=members)", () => adminOnly(async () => {
      const rows = await c.analyticsChart(gid, "members");
      const r = rows?.[rows.length - 1];
      return r && r.date && typeof r.total === "number" ? `ok (${rows!.length} months, latest total ${r.total})` : `FAIL shape changed: ${JSON.stringify(rows).slice(0, 120)}`;
    })));
    out.checks.push(await run("analytics: chart, two-step token (api2 analytics-v2 chart=signups_by_source)", () => adminOnly(async () => {
      const rows = (await c.analyticsChart(gid, "signups_by_source")) ?? [];
      if (rows.some((r: any) => typeof r.attribution !== "string" || typeof r.total !== "number")) return `FAIL item shape changed: ${JSON.stringify(rows[0]).slice(0, 120)}`;
      return `ok (${rows.length} sources, last 30 days)`;
    })));
    out.checks.push(await run("analytics: churned tab (next-data members t=churned)", () => adminOnly(async () => {
      const pp = await c.memberList(slug, { tab: "churned" });
      if (pp.tabName !== "churned") return `FAIL tabName=${pp.tabName} (t= ignored?)`;
      const u = (pp.users ?? [])[0];
      if (u && !u.member?.churned) return "FAIL member.churned missing (departure dates)";
      return `ok (${pp.total ?? 0} churned)`;
    })));
    out.checks.push(await run("analytics: billing filter (next-data members monthly+annual)", () => adminOnly(async () => {
      const pp = await c.memberList(slug, { filters: { monthly: "true", annual: "true" } });
      if (pp.monthly !== true || pp.annual !== true) return `FAIL filter not applied (monthly=${pp.monthly}, annual=${pp.annual})`;
      const users = pp.users ?? [];
      if (users.some((u: any) => !u.member?.metadata?.mmbp)) return "FAIL a paying member has no plan record (mmbp) — paid counts and income would be wrong";
      return `ok (${pp.total ?? users.length} paying)`;
    })));
    out.checks.push(await run("courses: one member's progress (api2 member-course-permissions)", () => adminOnly(async () => {
      const m = (membersPage?.users ?? []).find((u: any) => u.member?.role !== "group-admin")?.member;
      if (!m?.id) return "FAIL skipped: no member from the members check";
      const courses = await c.memberCourseProgress(gid, m.id);
      const published = courses.filter((k: any) => k.state === 2);
      if (!published.length) return hasPublishedCourse ? "FAIL no published course came back (progression param ignored, or shape changed)" : "ok (skipped: no published course in the classroom)";
      if (published.some((k: any) => typeof k.metadata?.user_completed !== "number" || typeof k.metadata?.num_modules !== "number")) return "FAIL user_completed / num_modules missing — the courses view would read every member as 0";
      return `ok (${published.length} published course(s))`;
    })));
    out.checks.push(await run("courses: last night's progress collection (KV, no Skool request)", async () => {
      if (!env.PROGRESS) return "FAIL PROGRESS KV binding missing — the courses view has no data";
      const snap = await latestProgress(env);
      if (!snap) return "FAIL no completed collection yet (runs every 3 min 06:00–07:57 UTC; GET /course-progress shows progress)";
      const hours = (Date.now() - Date.parse(snap.takenAt)) / 3_600_000;
      if (hours > PROGRESS_MAX_AGE_HOURS) return `FAIL last complete collection is ${Math.round(hours)}h old (${snap.takenAt}) — the nightly walk stalled; GET /course-progress shows lastError`;
      return `ok (${snap.members.length} of ${snap.membersOnList} members, ${snap.failed} failed, taken ${snap.takenAt.slice(0, 16)}Z)`;
    }));
  }

  out.ok = out.checks.every((k) => k.ok);
  return out;
}

export async function runHealthcheck(env: Env): Promise<{ ok: boolean; checkedAt: string; profiles: ProfileHealth[]; notified: boolean }> {
  const configured = profilesOf(env).map((p) => p.name).filter((p) => { try { tokenFor(p, env); return true; } catch { return false; } });
  // Warm the module-level buildId cache ONCE: the profiles run in parallel and would otherwise each fetch it (up to
  // three subrequests for one value). A failure here is ignored — each next-data check then reports it properly.
  if (configured.length) await new SkoolClient(tokenFor(configured[0], env), configured[0]).buildId().catch(() => {});
  const profiles = await Promise.all(configured.map((p, i) => checkProfile(p, env, i === 0)));
  const ok = profiles.every((p) => p.ok);
  let notified = false;
  if (!ok) notified = await notify(env, formatAlert(profiles));
  return { ok, checkedAt: new Date().toISOString(), profiles, notified };
}

function formatAlert(profiles: ProfileHealth[]): string {
  const lines = ["⚠️ Skool MCP health check failed"];
  for (const p of profiles) {
    const bad = p.checks.filter((k) => !k.ok);
    if (!bad.length) { lines.push(`✅ ${p.profile}: all ${p.checks.length} checks ok`); continue; }
    lines.push(`❌ ${p.profile}: ${bad.length} of ${p.checks.length} checks failed`);
    for (const k of bad) lines.push(`   • ${k.name}: ${k.detail.slice(0, 200)}`);
    if (p.daysLeft !== null && p.daysLeft < TOKEN_WARN_DAYS) lines.push(`   → paste a fresh auth_token: wrangler secret put SKOOL_TOKEN_${p.profile.toUpperCase()}`);
  }
  lines.push("Fix path: NOTES.md → Maintenance. `node scripts/smoke.mjs` shows which tools fail.");
  return lines.join("\n");
}

/** Telegram Bot API. No-ops when TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are not set. */
export async function notify(env: Env, text: string): Promise<boolean> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return false;
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
  });
  return res.ok;
}
