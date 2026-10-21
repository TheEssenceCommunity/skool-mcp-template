/** Turn Skool's raw shapes (camelCase from Next.js pages, snake_case from api2) into small stable objects. */
type Json = Record<string, any>;

const pick = (o: Json | undefined, camel: string, snake: string) => o?.[camel] ?? o?.[snake];

function parseSp(raw: unknown): Json {
  if (!raw) return {};
  if (typeof raw !== "string") return raw as Json;
  try { return JSON.parse(raw); } catch { return {}; }
}

/** Skool nests structured data as JSON *strings* inside metadata (attachments, prices, surveys, benefits). */
function embedded<T>(raw: unknown, fallback: T): T {
  if (raw === null || raw === undefined || raw === "") return fallback;
  if (typeof raw !== "string") return raw as T;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

/**
 * Attachments on a post or comment. Skool stores them twice: `attachments` (comma-joined ids) and
 * `attachments_data`, a JSON *string* holding the real records.
 *
 * This matters more than it looks. A comment whose whole message is a GIF has NO `content` key at all —
 * not an empty string, absent — so without this the comment normalizes to `content: ""` and reads as
 * an error or an empty post when it is nothing of the sort. GIFs (content_type "image/gif", sourced from
 * Giphy) are the common case; images and videos behave the same way. Returns null when there is nothing
 * attached, so the field simply does not appear on ordinary text comments.
 */
export function attachments(m: Json | undefined): Json[] | null {
  const data = embedded<Json[] | null>(pick(m, "attachmentsData", "attachments_data"), null);
  if (Array.isArray(data) && data.length) {
    return data.map((a: Json) => {
      const am = a.metadata ?? {};
      return {
        id: a.id ?? null,
        type: pick(am, "contentType", "content_type") ?? pick(am, "srcContentType", "src_content_type") ?? null,
        fileName: pick(am, "fileName", "file_name") ?? null,
        url: pick(am, "readUrl", "read_url") ?? pick(am, "srcReadUrl", "src_read_url") ?? null,
        thumbnailUrl: pick(am, "imageMdUrl", "image_md_url") ?? null,
      };
    });
  }
  // Feed/next-data pages carry the ids but not the records. Still worth signalling that something is
  // attached, so an apparently empty comment is not mistaken for a failed read.
  const ids = String(m?.attachments ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return ids.length ? ids.map((id) => ({ id, type: null, fileName: null, url: null, thumbnailUrl: null })) : null;
}

/**
 * Whether THIS account has liked a post or comment. Skool's field is `my_vote` on api2 and `myVote` on the
 * Next.js pages, and it is absent rather than "" when unvoted — so a plain truthiness check on one spelling
 * silently reports every post as unliked.
 */
function liked(m: Json | undefined): boolean {
  return (pick(m, "myVote", "my_vote") ?? "") === "up";
}

/** One Giphy search hit, trimmed to what is needed to show a choice and then attach it. */
export function gif(g: Json): Json {
  return {
    id: g.id,
    title: g.title || "(untitled)",
    url: g.images?.fixed_height?.url ?? null,
    thumbnailUrl: g.images?.fixed_height_small?.url ?? null,
  };
}

/** Embedded Skool-hosted video ids on a post/comment (the video itself needs the classroom/Mux route). */
function videoIds(m: Json | undefined): string[] | null {
  const ids = String(pick(m, "videoIds", "video_ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return ids.length ? ids : null;
}

/** Skool prices are JSON strings in minor units: {"currency":"usd","amount":8700,"recurring_interval":"month"}. */
function price(raw: unknown): Json | null {
  const p = embedded<Json | null>(raw, null);
  if (!p || typeof p.amount !== "number") return null;
  return {
    currency: p.currency ?? null,
    amount: p.amount / 100,
    interval: p.recurring_interval ?? p.recurringInterval ?? null,
  };
}

export function author(u: Json | undefined) {
  if (!u || !u.id) return null;
  const first = pick(u, "firstName", "first_name");
  const last = pick(u, "lastName", "last_name");
  return { id: u.id, handle: u.name ?? null, name: [first, last].filter(Boolean).join(" ") || u.name || null };
}

export function post(node: Json, slug: string) {
  const p = node.post ?? node;
  const m = p.metadata ?? {};
  const out: Json = {
    id: p.id,
    slug: p.name,
    url: `https://www.skool.com/${slug}/${p.name}`,
    title: m.title ?? "",
    content: m.content ?? "",
    author: author(p.user ?? node.user),
    commentCount: Number(m.comments ?? 0),
    upvotes: Number(m.upvotes ?? 0),
    likedByMe: liked(m),
    pinned: !!m.pinned,
    labelId: pick(p, "labelId", "label_id") ?? null,
    createdAt: pick(p, "createdAt", "created_at"),
    updatedAt: pick(p, "updatedAt", "updated_at"),
  };
  const att = attachments(m);
  if (att) out.attachments = att;
  const vids = videoIds(m);
  if (vids) out.videoIds = vids;
  const pl = poll(m);
  if (pl) out.poll = pl;
  return out;
}

export function comment(node: Json): Json {
  const p = node.post ?? node;
  const m = p.metadata ?? {};
  const out: Json = {
    id: p.id,
    content: m.content ?? "",
    author: author(p.user ?? node.user),
    upvotes: Number(m.upvotes ?? 0),
    likedByMe: liked(m),
    parentId: pick(p, "parentId", "parent_id") ?? null,
    createdAt: pick(p, "createdAt", "created_at"),
  };
  // A GIF-only comment has no `content` at all; without these the comment reads as empty. See attachments().
  const att = attachments(m);
  if (att) out.attachments = att;
  const vids = videoIds(m);
  if (vids) out.videoIds = vids;
  const kids = node.children ?? node.comments;
  if (Array.isArray(kids) && kids.length) out.replies = kids.map(comment);
  return out;
}

/** Skool stores the join-application answers as a JSON string in member.metadata.survey; returns [{question, answer}] or null. */
export function applicationAnswers(mem: Json | undefined): Array<{ question: string; answer: string }> | null {
  let survey: unknown = mem?.metadata?.survey ?? null;
  if (typeof survey === "string") { try { survey = JSON.parse(survey); } catch { return null; } }
  const list = (survey as Json)?.survey;
  return Array.isArray(list) ? list.map((q: Json) => ({ question: q.question, answer: q.answer })) : null;
}

export function member(u: Json, includeEmail: boolean, includeAnswers = false) {
  const meta = u.metadata ?? {};
  const sp = parseSp(pick(meta, "spData", "sp_data"));
  const mem = u.member ?? {};
  const out: Json = {
    id: u.id,
    membershipId: mem.id ?? null,
    handle: u.name,
    name: [pick(u, "firstName", "first_name"), pick(u, "lastName", "last_name")].filter(Boolean).join(" ") || u.name,
    role: mem.role ?? null,
    level: sp.lv ?? null,
    points: sp.pts ?? null,
    online: meta.online === 1 || meta.online === true,
    bio: meta.bio ?? "",
    joinedAt: pick(mem, "approvedAt", "approved_at") ?? null,
    timeZone: pick(u, "timeZone", "time_zone") ?? null,
  };
  if (includeEmail && u.email) out.email = u.email;
  if (includeAnswers) out.applicationAnswers = applicationAnswers(mem);
  return out;
}

/** A pending join request, including the application answers Skool stores as a JSON string in member.metadata.survey. */
export function pendingRequest(u: Json) {
  const mem = u.member ?? {};
  const md = mem.metadata ?? {};
  const answers = applicationAnswers(mem);
  return {
    userId: u.id,
    membershipId: mem.id ?? null,
    handle: u.name,
    name: [pick(u, "firstName", "first_name"), pick(u, "lastName", "last_name")].filter(Boolean).join(" ") || u.name,
    email: u.email ?? null,
    requestedAt: (u.member ?? {}).approvedAt ?? null,
    location: md.requestLocation ?? null,
    previousRequests: md.numRequests ?? null,
    answers,
  };
}

export function label(l: Json) {
  const m = l.metadata ?? {};
  return { id: l.id, name: pick(m, "displayName", "display_name") ?? l.name ?? null, postCount: m.posts ?? null, color: m.color ?? null };
}

export function event(e: Json, slug: string) {
  const m = e.metadata ?? {};
  let location: unknown = m.location ?? null;
  if (typeof location === "string") { try { location = JSON.parse(location); } catch { /* keep raw */ } }
  return {
    id: e.id,
    occurrenceId: e.occurrenceId ?? null,
    title: m.title ?? "",
    description: m.description ?? "",
    start: pick(e, "startTime", "start_time"),
    end: pick(e, "endTime", "end_time"),
    timezone: m.timezone ?? null,
    location,
    url: `https://www.skool.com/${slug}/calendar`,
  };
}

/**
 * One DM channel.
 *
 * Two fields that look like they live in `metadata` do not, and reading them from there silently yields
 * nothing rather than failing:
 *   - `user` (top level) is the OTHER participant, already resolved by Skool into a full user record. It is
 *     what lets a conversation say who it is *with*; without it an inbox is a list of opaque channel ids.
 *   - `last_message` (top level) is the message object. The old code read `metadata.last_msg`, which does
 *     not exist, so every conversation reported lastMessage: null however recent the exchange.
 *
 * `user_ids` holds both participants, so the acting account is whichever id is not the other person — that
 * gives startedByMe without needing a separate /self call.
 */
export function conversation(ch: Json): Json {
  const m = ch.metadata ?? {};
  const other = ch.user ?? null;
  const ids: string[] = ch.user_ids ?? ch.userIds ?? [];
  const selfId = other?.id ? ids.find((i) => i !== other.id) ?? null : null;
  const startedBy = m.first_msg_user ?? m.request_user ?? null;
  const last = ch.last_message ?? ch.lastMessage ?? null;
  return {
    channelId: ch.id,
    with: author(other),
    unread: Number(m.num_unread ?? m.numUnread ?? 0),
    startedByMe: startedBy && selfId ? startedBy === selfId : null,
    sharedCommunities: m.shared_groups ?? null,
    lastMessage: last ? message(last) : null,
    lastMessageAt: pick(ch, "lastMessageAt", "last_message_at") ?? null,
    updatedAt: pick(ch, "updatedAt", "updated_at") ?? null,
  };
}

export function message(msg: Json): Json {
  const m = msg.metadata ?? {};
  const out: Json = {
    id: msg.id,
    from: m.src ?? pick(msg, "userId", "user_id") ?? null,
    to: m.dst ?? null,
    content: m.content ?? "",
    createdAt: pick(msg, "createdAt", "created_at"),
  };
  // A DM carries a GIF or image exactly the way a comment does — as an attachment, with no text. Without
  // this a GIF-only message reads as an empty conversation turn. See attachments().
  const att = attachments(m);
  if (att) out.attachments = att;
  return out;
}

// ---------- discovery (communities the account has NOT joined) ----------

/**
 * One card from the public discovery feed (camelCase, from the Next.js page route).
 * `publicFeed` is the field that decides what else is reachable: when Skool's group record carries
 * top-level `public: true` (equivalently privacy 0), a non-member can read the whole feed and its
 * comments with the ordinary post tools. Otherwise only the About page is visible.
 */
export function discoveryGroup(node: Json) {
  const g = node.group ?? node;
  const m = g.metadata ?? {};
  return {
    slug: g.name,
    name: pick(m, "displayName", "display_name") ?? g.name,
    aboutUrl: `https://www.skool.com/${g.name}/about`,
    tagline: m.description ?? "",
    totalMembers: pick(m, "totalMembers", "total_members") ?? null,
    price: price(pick(m, "displayPrice", "display_price")),
    publicFeed: g.public === true,
    createdAt: pick(g, "createdAt", "created_at") ?? null,
  };
}

/**
 * A community's full About page, from api2 GET /groups/{slug} — the same record Skool's own /about
 * route renders. Works for any community, joined or not, and without authentication.
 * `about` (lp_description) is the long landing-page body; `tagline` (description) is the one-liner
 * shown on discovery cards.
 */
export function groupAbout(g: Json) {
  const m = g.metadata ?? {};
  const owner = embedded<Json | null>(m.owner, null);
  const survey = embedded<Json | null>(m.survey, null);
  return {
    slug: g.name,
    id: g.id,
    name: pick(m, "displayName", "display_name") ?? g.name,
    aboutUrl: `https://www.skool.com/${g.name}/about`,
    tagline: m.description ?? "",
    about: pick(m, "lpDescription", "lp_description") ?? "",
    // Whether the ordinary post tools work here without joining.
    publicFeed: g.public === true,
    privacy: m.privacy ?? null,
    totalMembers: pick(m, "totalMembers", "total_members") ?? null,
    totalAdmins: pick(m, "totalAdmins", "total_admins") ?? null,
    totalPosts: pick(m, "totalPosts", "total_posts") ?? null,
    onlineMembers: pick(m, "totalOnlineMembers", "total_online_members") ?? null,
    courses: pick(m, "numCourses", "num_courses") ?? null,
    modules: pick(m, "numModules", "num_modules") ?? null,
    rating: pick(m, "reviewAverageRating", "review_average_rating") ?? null,
    reviewCount: pick(m, "reviewCount", "review_count") ?? null,
    monthlyPrice: price(pick(m, "currentMBp", "current_m_bp")),
    annualPrice: price(pick(m, "currentABp", "current_a_bp")),
    freeTrial: !!pick(m, "freeTrialEnabled", "free_trial_enabled"),
    benefits: embedded<string[]>(pick(m, "freeBenefits", "free_benefits"), []),
    joinQuestions: Array.isArray(survey?.survey) ? survey!.survey.map((q: Json) => q.question) : [],
    owner: owner ? { ...author(owner), bio: owner.metadata?.bio ?? "", location: owner.metadata?.location ?? "" } : null,
    createdAt: pick(g, "createdAt", "created_at") ?? null,
  };
}

/** A member review of a community (api2 GET /groups/{groupId}/reviews). */
export function review(r: Json) {
  return {
    rating: r.rating ?? null,
    body: r.body ?? "",
    author: author(r.user),
    memberSince: pick(r, "memberSince", "member_since") ?? null,
    stillPaying: pick(r, "memberCurrentlyPaying", "member_currently_paying") ?? null,
    createdAt: pick(r, "createdAt", "created_at") ?? null,
  };
}

// ---------- classroom / courses ----------

/**
 * Skool lesson bodies are ProseMirror JSON behind a literal "[v2]" prefix, not text or HTML.
 * Rendered to markdown here because the raw JSON is unreadable and dominates a tool response.
 * Older lessons may be plain text/HTML with no prefix; those are passed through unchanged.
 */
export function richText(raw: unknown): string {
  if (typeof raw !== "string" || !raw) return "";
  if (!raw.startsWith("[v2]")) return raw;
  let doc: any;
  try { doc = JSON.parse(raw.slice(4)); } catch { return raw; }
  const nodes: Json[] = Array.isArray(doc) ? doc : doc?.content ?? [];

  const inline = (ns: Json[] = []): string => ns.map((n) => {
    if (n.type === "hardBreak") return "\n";
    if (n.type === "image") return `![${n.attrs?.alt ?? ""}](${n.attrs?.src ?? ""})`;
    let t = n.text ?? inline(n.content);
    for (const mk of n.marks ?? []) {
      if (mk.type === "bold" || mk.type === "strong") t = `**${t}**`;
      else if (mk.type === "italic" || mk.type === "em") t = `*${t}*`;
      else if (mk.type === "code") t = `\`${t}\``;
      else if (mk.type === "link") t = `[${t}](${mk.attrs?.href ?? ""})`;
    }
    return t;
  }).join("");

  const block = (n: Json, depth = 0): string => {
    const pad = "  ".repeat(depth);
    switch (n.type) {
      case "heading": return `${"#".repeat(Math.min(6, n.attrs?.level ?? 2))} ${inline(n.content)}`;
      case "paragraph": return inline(n.content);
      case "horizontalRule": return "---";
      case "codeBlock": return "```\n" + inline(n.content) + "\n```";
      case "blockquote": return (n.content ?? []).map((c: Json) => `> ${block(c, depth)}`).join("\n");
      case "unorderedList": case "bulletList":
        return (n.content ?? []).map((li: Json) => `${pad}- ${(li.content ?? []).map((c: Json) => block(c, depth + 1)).join(" ").trim()}`).join("\n");
      case "orderedList":
        return (n.content ?? []).map((li: Json, i: number) => `${pad}${i + 1}. ${(li.content ?? []).map((c: Json) => block(c, depth + 1)).join(" ").trim()}`).join("\n");
      case "listItem": return (n.content ?? []).map((c: Json) => block(c, depth)).join(" ");
      default: return n.content ? (n.content as Json[]).map((c) => block(c, depth)).join("\n") : (n.text ?? "");
    }
  };
  return nodes.map((n) => block(n)).join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * The reverse of richText: markdown -> Skool's "[v2]" + ProseMirror JSON, for writing a lesson body.
 * Node and mark names are the ones Skool's editor schema defines (heading with attrs.level, paragraph,
 * unorderedList / orderedList > listItem > paragraph, hardBreak, horizontalRule; bold, italic, code and link
 * marks). Verified live 2026-09-23: a body using every one of them was written to a test lesson and read back
 * with identical content — Skool re-serializes it (`marks` before `text`), so compare parsed, not as strings.
 *
 * Supported: #..###### headings, paragraphs (a single newline inside one becomes a line break), "- " / "* "
 * bullets, "1. " numbered items, "---" rules, **bold**, *italic*, `code`, [text](url). Anything else is
 * kept as literal text rather than guessed at.
 */
export function markdownToRichText(md: string): string {
  const doc: Json[] = [];
  let para: string[] = [];
  let list: { type: "unorderedList" | "orderedList"; items: string[] } | null = null;

  const paragraph = (lines: string[]): Json => {
    const content: Json[] = [];
    lines.forEach((l, i) => {
      if (i) content.push({ type: "hardBreak" });
      content.push(...inlineNodes(l));
    });
    return content.length ? { type: "paragraph", content } : { type: "paragraph" };
  };
  const flushPara = () => { if (para.length) doc.push(paragraph(para)); para = []; };
  const flushList = () => {
    if (list) doc.push({ type: list.type, content: list.items.map((t) => ({ type: "listItem", content: [paragraph([t])] })) });
    list = null;
  };

  for (const raw of md.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) { flushPara(); flushList(); continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flushPara(); flushList(); doc.push({ type: "heading", attrs: { level: h[1].length }, content: inlineNodes(h[2]) }); continue; }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { flushPara(); flushList(); doc.push({ type: "horizontalRule" }); continue; }
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const type = ul ? "unorderedList" : "orderedList";
      if (list && list.type !== type) flushList();
      if (!list) list = { type, items: [] };
      list.items.push((ul ?? ol)![1]);
      continue;
    }
    flushList();
    para.push(line.trim());
  }
  flushPara(); flushList();
  return "[v2]" + JSON.stringify(doc);
}

function withMark(n: Json, mark: Json): Json {
  return { ...n, marks: [...(n.marks ?? []), mark] };
}

/** Inline markdown -> ProseMirror text nodes. ProseMirror rejects empty text nodes, so those are dropped. */
function inlineNodes(s: string): Json[] {
  const out: Json[] = [];
  const re = /\*\*(.+?)\*\*|\[([^\]]+)\]\(([^)\s]+)\)|`([^`]+)`|(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push({ type: "text", text: s.slice(last, m.index) });
    if (m[1] !== undefined) out.push(...inlineNodes(m[1]).map((n) => withMark(n, { type: "bold" })));
    else if (m[2] !== undefined) out.push(...inlineNodes(m[2]).map((n) => withMark(n, { type: "link", attrs: { href: m![3] } })));
    else if (m[4] !== undefined) out.push(withMark({ type: "text", text: m[4] }, { type: "code" }));
    else out.push(...inlineNodes(m[5]).map((n) => withMark(n, { type: "italic" })));
    last = re.lastIndex;
  }
  if (last < s.length) out.push({ type: "text", text: s.slice(last) });
  return out.filter((n) => n.text);
}

/**
 * A YouTube link, cleaned up the way Skool's editor does before saving it: trimmed, given a scheme if it has none,
 * /shorts/ and /live/ rewritten to watch?v=, and any playlist (`list`) dropped. Returns null for anything that is
 * not YouTube — Skool accepts Vimeo, Loom and Wistia too, but only YouTube has been verified here.
 */
export function youtubeLink(raw: string): { url: string; videoId: string } | null {
  let s = raw.trim();
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  switch (u.hostname) {
    case "www.youtube.com": case "youtube.com": case "m.youtube.com": {
      for (const prefix of ["/shorts/", "/live/"]) {
        if (u.pathname.startsWith(prefix)) {
          const id = u.pathname.slice(prefix.length);
          return id ? { url: `https://www.youtube.com/watch?v=${id}`, videoId: id } : null;
        }
      }
      u.searchParams.delete("list");
      const id = u.searchParams.get("v") ?? "";
      return id ? { url: u.toString(), videoId: id } : null;
    }
    case "youtu.be": {
      u.searchParams.delete("list");
      const id = u.pathname.slice(1);
      return id ? { url: u.toString(), videoId: id } : null;
    }
    default: return null;
  }
}

/**
 * How a lesson's video is hosted, which decides how Skool marks the lesson done for a member (tested 2026-10-11):
 *   uploaded — hosted on Skool (metadata.videoId): done automatically once the member reaches 90% of the video
 *              (reaching it, not time watched: scrubbing counts);
 *   youtube  — a YouTube link (metadata.videoLink): done only when the member presses Done;
 *   linked   — any other provider's link (Loom, Vimeo, Wistia, …), `provider` is its host: NOT tested, assume
 *              Done-button until checked;
 *   none     — no video.
 * The link's host is what tells providers apart: Skool's own YouTube links are youtu.be, not youtube.com.
 */
export function videoKind(m: Json | undefined): { kind: "uploaded" | "youtube" | "linked" | "none"; provider: string | null } {
  if (m?.videoId) return { kind: "uploaded", provider: "skool" };
  const link = m?.videoLink;
  if (!link || typeof link !== "string") return { kind: "none", provider: null };
  let host: string;
  try { host = new URL(link).hostname.toLowerCase().replace(/^(www|m)\./, ""); } catch { return { kind: "linked", provider: "unknown" }; }
  if (host === "youtu.be" || host === "youtube.com" || host === "youtube-nocookie.com" || host.endsWith(".youtube.com")) return { kind: "youtube", provider: "youtube" };
  return { kind: "linked", provider: host };
}

export interface VideoCounts { lessons: number; uploaded: number; youtube: number; linkedOther: Record<string, number>; noVideo: number }

/** Published lessons in a course tree, by how their video is hosted. A lesson counts only when it and every section above it is published. */
export function lessonVideoCounts(node: Json): VideoCounts {
  const out: VideoCounts = { lessons: 0, uploaded: 0, youtube: 0, linkedOther: {}, noVideo: 0 };
  const walk = (n: Json) => {
    for (const ch of n.children ?? []) {
      const u = ch.course ?? ch;
      if (u.state !== 2) continue;
      if (u.unitType === "module") {
        out.lessons++;
        const v = videoKind(u.metadata);
        if (v.kind === "uploaded") out.uploaded++;
        else if (v.kind === "youtube") out.youtube++;
        else if (v.kind === "linked") out.linkedOther[v.provider!] = (out.linkedOther[v.provider!] ?? 0) + 1;
        else out.noVideo++;
      }
      walk(ch);
    }
  };
  walk(node);
  return out;
}

/** A course as it appears in the classroom index. `slug` is the URL segment, not the title. */
export function courseSummary(c: Json) {
  const m = c.metadata ?? {};
  return {
    id: c.id,
    slug: c.name,
    title: m.title ?? "",
    description: richText(m.desc),
    modules: m.numModules ?? null,
    hasAccess: m.hasAccess === 1 || m.hasAccess === true,
    published: c.state === 2,
    createdAt: pick(c, "createdAt", "created_at") ?? null,
  };
}

/**
 * The course's section/lesson tree. Skool nests each node as {course, children}; a node's unitType is
 * "set" for a section and "module" for a lesson.
 * NOTE: only titles and videoId are present here. A lesson's body, resources and transcript exist ONLY
 * when that lesson is the selected module (md=<id>), so reading lesson content needs one fetch each —
 * that is what skool_get_lesson does.
 */
export function courseTree(node: Json): Json[] {
  return (node.children ?? []).map((child: Json) => {
    const u = child.course ?? child;
    const m = u.metadata ?? {};
    const out: Json = {
      id: u.id,
      type: u.unitType === "set" ? "section" : "lesson",
      title: m.title ?? "",
      hasAccess: m.hasAccess === 1 || m.hasAccess === true,
      published: u.state === 2,
    };
    if (m.videoId) out.videoId = m.videoId;
    if (m.videoLink) out.videoLink = m.videoLink;
    if (u.unitType === "module") { const v = videoKind(m); if (v.kind !== "none") out.videoKind = v.kind === "linked" ? `linked (${v.provider})` : v.kind; }
    // The READING profile's own progress: Skool sets metadata.completed = 1 on a lesson that profile finished and
    // omits it otherwise. Verified 2026-10-10. Other members: only a per-course COUNT, admin-only
    // (SkoolClient.memberCourseProgress); no route found that says which lessons another member finished.
    if (u.unitType === "module") out.completedByProfile = m.completed === 1;
    const kids = courseTree(child);
    if (kids.length) out.children = kids;
    return out;
  });
}

/** One lesson, fetched as the selected module. `video` comes from pageProps.video, not the module metadata. */
export function lesson(mod: Json, video: Json | undefined, courseSlug: string, communitySlug: string) {
  const m = mod.metadata ?? {};
  const resources = embedded<Json[]>(m.resources, []);
  const out: Json = {
    id: mod.id,
    title: m.title ?? "",
    body: richText(m.desc),
    url: `https://www.skool.com/${communitySlug}/classroom/${courseSlug}?md=${mod.id}`,
    hasAccess: m.hasAccess === 1 || m.hasAccess === true,
    resources: Array.isArray(resources) ? resources : [],
  };
  // Skool has its own transcript field but leaves it empty on auto-captioned videos; when set it is free to read.
  if (m.transcript) out.transcript = m.transcript;
  // A linked video (YouTube etc.) lives in videoLink; a Skool-hosted upload in videoId. A lesson has one or the other.
  if (m.videoLink) {
    out.videoLink = {
      url: m.videoLink,
      durationMinutes: m.videoLenMs ? Math.round(m.videoLenMs / 60000) : null,
      thumbnail: m.videoThumbnail || null,
    };
  }
  if (m.videoId) {
    out.video = {
      videoId: m.videoId,
      durationMinutes: video?.duration ? Math.round(video.duration / 60000) : null,
      status: video?.status ?? null,
      // Captions are fetched separately by skool_get_transcript — they are not in this payload.
      transcriptAvailable: !m.transcript ? "call skool_get_transcript" : "inline above",
    };
  }
  return out;
}

// ---------- notifications / leaderboard / rules / levels ----------

/** One notification. metadata.data is a JSON string carrying the actual event. */
export function notification(n: Json, communityById?: Map<string, string>) {
  const d = embedded<Json>(n.metadata?.data, {});
  const groupId = d.group_id ?? n.group_id ?? null;
  return {
    id: n.id,
    action: n.action ?? d.action ?? null,
    unread: n.unread === true || n.unread === 1,
    at: pick(n, "createdAt", "created_at") ?? null,
    from: d.display_name ?? null,
    community: d.group_display_name ?? (groupId && communityById?.get(groupId)) ?? null,
    text: (d.text ?? d.content ?? "").toString().slice(0, 400),
    postId: d.post_id ?? null,
    rootPostId: d.root_post_id ?? null,
    // link_href is the Next.js route PATTERN ("/[group]/[post]"); link_as is the real resolved path.
    url: d.link_as ? `https://www.skool.com${d.link_as}` : null,
  };
}

export function leaderboardUser(e: Json, rank: number) {
  const u = e.user ?? {};
  const sp = parseSp(pick(u.metadata ?? {}, "spData", "sp_data"));
  return { rank, ...author(u), points: e.points ?? sp.pts ?? null, level: sp.lv ?? null };
}

export function groupLevel(l: Json) {
  return {
    number: l.number,
    title: l.title ?? l.name ?? null,
    percentOfMembers: pick(l, "percentOfMembers", "percent_of_members") ?? null,
    unlocks: (l.actions ?? []).map((a: Json) => a.name),
  };
}

export function rule(r: Json, i: number) {
  const m = r.metadata ?? r;
  return { number: i + 1, title: m.title ?? "", description: richText(m.desc ?? m.description) || (m.description ?? "") };
}

/**
 * Poll results as they ride along on a post (metadata.pollData, a JSON string).
 * Each entry's `users` is itself a JSON string of user records, so voters are available without a
 * second call; skool_create_poll's tool description explains how a poll attaches to a post.
 */
export function poll(m: Json | undefined): Json | null {
  const id = m?.poll;
  const data = embedded<Json | null>(pick(m, "pollData", "poll_data"), null);
  const entries = data?.entries;
  if (!id && !Array.isArray(entries)) return null;
  const options = (Array.isArray(entries) ? entries : []).map((e: Json, i: number) => ({
    index: i,
    text: e.text ?? "",
    votes: e.count ?? 0,
    voters: embedded<Json[]>(e.users, []).map((u: Json) => author(u)).filter(Boolean),
  }));
  return { pollId: id ?? null, totalVotes: options.reduce((n, o) => n + (o.votes ?? 0), 0), options };
}
