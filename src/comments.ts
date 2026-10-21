/**
 * Paged reading of a post's comments.
 *
 * Skool's `GET /posts/{id}/comments` returns 10 top-level threads (replies nested inside each) unless told
 * otherwise, and the old `SkoolClient.comments()` read exactly that one page and dropped the cursor — so a
 * post with 175 comments showed 10. Everything below was verified live on 2026-10-10 against a 175-comment post:
 *
 *   - `limit` is honoured up to 30; 31+ is HTTP 400 "invalid limit". Default (no param) is 10.
 *   - The unit is a TOP-LEVEL THREAD. Replies come nested inside it and are not paged separately (depth is 2:
 *     Skool flattens replies-to-replies under the thread).
 *   - Threads are ordered by created_at, oldest first. The response carries `last`, a microsecond timestamp:
 *       forward  (`created-gt=<n>`): last = created_at of the NEWEST thread returned -> pass it as created-gt.
 *       backward (`tail=1`, then `created-lt=<n>`): the page is the window of threads just BEFORE the cursor,
 *                still ascending inside it; last = created_at of its OLDEST thread -> pass it as created-lt.
 *     `last: 0` means there is nothing further in that direction. `tail` and `created-lt` cannot be combined
 *     in one request ("multiple pagination parameters not supported"), which is why the first newest-first
 *     page uses `tail=1` and every later one uses `created-lt`.
 *   - `created-gt` / `created-lt` take the integer microseconds; an ISO string is silently ignored.
 *   - Pinned threads are NOT in the normal list. They come back only when `pinned=1` is sent, in a separate
 *     `pinned_post_tree`. On the verification post that was 1 thread + 6 replies = the 7 comments missing from
 *     the list (168 listed + 7 pinned = the post's own counter of 175).
 */
import * as N from "./normalize";
import type { SkoolClient } from "./skool";

type Json = Record<string, any>;

/** Skool rejects anything above this with HTTP 400. */
export const MAX_THREADS_PER_PAGE = 30;
/** Skool's own default page, kept so an unparameterised call returns what it always did. */
export const DEFAULT_THREADS_PER_PAGE = 10;

export type Order = "oldest" | "newest";

/** `after:<µs>` continues oldest-first; `before:<µs>` continues newest-first. The direction travels with the cursor. */
const CURSOR_RE = /^(after|before):(\d{12,19})$/;

export interface Cursor { dir: "after" | "before"; at: number }

export function parseCursor(raw: string): Cursor {
  const m = CURSOR_RE.exec(raw.trim());
  if (!m) throw new Error(`Invalid cursor "${raw}". Pass the nextCursor value exactly as a previous skool_get_comments call returned it (it looks like after:1778694085437557).`);
  return { dir: m[1] as Cursor["dir"], at: Number(m[2]) };
}

const formatCursor = (dir: Cursor["dir"], at: number) => `${dir}:${at}`;

/** RFC3339 with up to nanosecond fraction -> integer microseconds. 1.78e15 is well inside Number's exact range. */
export function toMicros(iso: string): number {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(iso);
  if (!m) throw new Error(`Unrecognised timestamp "${iso}" on a comment.`);
  return (Date.parse(`${m[1]}Z`) / 1000) * 1_000_000 + Number((m[2] ?? "").padEnd(6, "0").slice(0, 6));
}

/** Attachments as the reading tools show them by default: what kind of thing and what it was called. */
function slim(c: Json): Json {
  if (Array.isArray(c.attachments)) c.attachments = c.attachments.map((a: Json) => ({ type: a.type ?? null, fileName: a.fileName ?? null }));
  if (Array.isArray(c.replies)) c.replies = c.replies.map(slim);
  return c;
}

/** Normalize one raw thread; `urls` keeps Skool's full attachment records (long GIF urls) instead of type + fileName. */
const shape = (node: Json, urls: boolean): Json => (urls ? N.comment(node) : slim(N.comment(node)));

const countAll = (t: Json): number => 1 + (t.replies ?? []).reduce((n: number, r: Json) => n + countAll(r), 0);

/** Characters a thread adds to the final output, which `text()` indents by one space per level. */
function cost(t: Json): number {
  const s = JSON.stringify(t, null, 1);
  return s.length + 2 * (s.split("\n").length + 1);
}

export interface PageOpts {
  limit: number;
  order?: Order;
  cursor?: string;
  attachmentUrls: boolean;
  /** Characters this page may add to the response; at least one thread is always returned. */
  budget: number;
}

export interface CommentsPage {
  order: Order;
  /** Top-level threads on this page (replies nested), in the order named by `order`. */
  comments: Json[];
  /** Pinned threads. First page only; empty otherwise or when the post has none. */
  pinned: Json[];
  threads: number;
  /** Every comment this page carries, replies and pinned included. */
  commentsInPage: number;
  hasMore: boolean;
  nextCursor: string | null;
  /** True when fewer threads than `limit` were returned because the page would not fit the output cap. */
  trimmedForSize: boolean;
}

export async function readCommentsPage(c: SkoolClient, groupId: string, postId: string, o: PageOpts): Promise<CommentsPage> {
  const limit = Math.min(Math.max(Math.trunc(o.limit) || DEFAULT_THREADS_PER_PAGE, 1), MAX_THREADS_PER_PAGE);
  const cur = o.cursor ? parseCursor(o.cursor) : null;
  if (cur && o.order && ((cur.dir === "after") !== (o.order === "oldest"))) {
    throw new Error(`The cursor continues ${cur.dir === "after" ? "oldest-first" : "newest-first"} but order="${o.order}" was also passed. Drop \`order\` — the cursor already carries the direction.`);
  }
  const order: Order = cur ? (cur.dir === "after" ? "oldest" : "newest") : (o.order ?? "oldest");
  const first = !cur;

  const raw = await c.commentsPage(groupId, postId, {
    limit,
    pinned: first,
    createdGt: cur?.dir === "after" ? cur.at : undefined,
    createdLt: cur?.dir === "before" ? cur.at : undefined,
    tail: first && order === "newest",
  });

  // Skool returns each window ascending; newest-first is that window read backwards.
  const ordered = order === "newest" ? [...raw.threads].reverse() : raw.threads;
  const pinned = raw.pinned.map((n) => shape(n, o.attachmentUrls));
  let room = o.budget - pinned.reduce((n, t) => n + cost(t), 0);

  const comments: Json[] = [];
  for (const node of ordered) {
    const t = shape(node, o.attachmentUrls);
    const w = cost(t);
    // Always keep the first thread so a single oversized one still makes progress instead of looping forever.
    if (comments.length > 0 && w > room) break;
    comments.push(t);
    room -= w;
  }

  const trimmed = comments.length < ordered.length;
  const commentsInPage = comments.reduce((n, t) => n + countAll(t), 0) + pinned.reduce((n, t) => n + countAll(t), 0);

  // The cursor is the boundary thread in the direction of travel. When nothing was trimmed that is exactly
  // Skool's own `last`; when we trimmed, `last` points past threads we did not return, so derive it from the
  // last thread we did return (same microsecond encoding, verified equal to `last` on untrimmed pages).
  let nextCursor: string | null = null;
  if (comments.length > 0) {
    const dir = order === "oldest" ? "after" : "before";
    if (trimmed) nextCursor = formatCursor(dir, toMicros(comments[comments.length - 1].createdAt));
    else if (raw.last > 0) nextCursor = formatCursor(dir, raw.last);
  }

  return { order, comments, pinned, threads: comments.length, commentsInPage, hasMore: nextCursor !== null, nextCursor, trimmedForSize: trimmed };
}

/** The comment counter on a post/comment record as returned by GET /posts/{id}, or null when absent. */
export function commentTotal(rawPost: Json | null | undefined): number | null {
  const n = rawPost?.metadata?.comments ?? rawPost?.post?.metadata?.comments;
  return typeof n === "number" ? n : null;
}

/** Standard paging fields for a tool response, shared by skool_get_comments and skool_get_post. */
export function pageFields(p: CommentsPage, how: (cursor: string) => string): Json {
  const out: Json = {
    order: p.order,
    count: p.threads,
    commentsInPage: p.commentsInPage,
    hasMore: p.hasMore,
  };
  if (p.hasMore && p.nextCursor) {
    out.nextCursor = p.nextCursor;
    out.next = how(p.nextCursor);
  }
  if (p.trimmedForSize) out.trimmedForSize = true;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Health-check support. These probe Skool's paging CONTRACT (the parameters and the `last` cursor documented at the
// top of this file) on a real post, so a Skool change shows up in the daily check instead of as comments quietly
// missing from a read. Each returns a detail string; one starting "FAIL" marks the check failed (healthcheck.ts).
// ---------------------------------------------------------------------------------------------------------------

/**
 * How far Skool's comment counter may sit from what paging can read before the check fails. Measured 2026-10-11 over
 * 113 posts: 81 of 81 in a small community matched exactly; on the large public Skoolers community 2 posts ran
 * ahead of what was readable (582 vs 573, 105 vs 104), cause not established. A small tolerance keeps that kind of
 * drift from paging anyone, while a lost pinned thread (7 comments on the verification post) still fails.
 */
export const COUNTER_TOLERANCE = 2;

/** Skool's window size for the first probe: the newest threads, up to the 30-thread ceiling. */
const PROBE_LIMIT = MAX_THREADS_PER_PAGE;

const rawCount = (n: Json): number => 1 + (n.children ?? []).reduce((s: number, k: Json) => s + rawCount(k), 0);

export interface PagingProbe {
  postId: string;
  /** The newest threads, oldest first, exactly as Skool returned them. */
  threads: Json[];
}

/**
 * Probe 1: the newest window (`tail`, `limit`, `pinned`). Checks the shape of a thread, that the window is ascending
 * and unique, that `limit` is honoured, that `last` is still the oldest thread's created_at, and — when the whole
 * thread fitted in this one request — that what was read agrees with the post's own counter.
 */
export async function probeNewest(c: SkoolClient, groupId: string, postId: string, counter: number | null): Promise<{ detail: string; probe: PagingProbe }> {
  const r = await c.commentsPage(groupId, postId, { limit: PROBE_LIMIT, tail: true, pinned: true });
  const probe: PagingProbe = { postId, threads: r.threads };
  const fail = (m: string) => ({ detail: `FAIL ${m}`, probe });
  const t = r.threads;
  if (t.length > PROBE_LIMIT) return fail(`limit ignored: asked for ${PROBE_LIMIT}, got ${t.length} threads`);
  if (t.some((n) => !n.post?.id || typeof n.post?.created_at !== "string")) return fail("thread shape changed (no post.id / created_at)");
  if (new Set(t.map((n) => n.post.id)).size !== t.length) return fail("a thread came back twice in one window");
  const at = t.map((n) => toMicros(n.post.created_at));
  if (at.some((v, i) => i > 0 && v < at[i - 1])) return fail("the window is no longer oldest-to-newest");
  if (t.length && r.last !== 0 && r.last !== at[0]) return fail(`\`last\` (${r.last}) is no longer the oldest thread's created_at (${at[0]}) — cursors would skip or repeat comments`);
  if (!Array.isArray(r.pinned) || r.pinned.some((n) => !n.post?.id)) return fail("pinned_post_tree shape changed");

  const reachable = t.reduce((n, k) => n + rawCount(k), 0) + r.pinned.reduce((n, k) => n + rawCount(k), 0);
  const pinnedNote = r.pinned.length ? `, ${r.pinned.length} pinned` : "";
  if (t.length === PROBE_LIMIT || counter === null) return { detail: `ok (newest ${t.length} threads${pinnedNote}; counter not reconciled: more than one window)`, probe };
  const gap = counter - reachable;
  if (Math.abs(gap) > COUNTER_TOLERANCE) {
    return fail(`the post counts ${counter} comments but paging reads ${reachable} (${t.length} threads${pinnedNote}) — comments are being missed, or the pinned / replies handling changed`);
  }
  return { detail: `ok (${reachable} of ${counter} comments read${gap ? `, ${Math.abs(gap)} off` : ""}; ${t.length} threads${pinnedNote})`, probe };
}

/**
 * Probe 2, two requests: from the two newest threads A < B, `created-gt` A must return exactly B, and `created-lt` B
 * must return exactly A, each with `limit: 1` honoured and `last` still the boundary thread's created_at. This is the
 * continuation every page after the first depends on, in both directions.
 */
export async function probeContinuation(c: SkoolClient, groupId: string, probe: PagingProbe): Promise<string> {
  const t = probe.threads;
  if (t.length < 2) return "ok (skipped: the post probed has fewer than two threads)";
  const A = t[t.length - 2].post, B = t[t.length - 1].post;
  const aAt = toMicros(A.created_at), bAt = toMicros(B.created_at);
  if (aAt === bAt) return "ok (skipped: the two newest threads share a timestamp)";

  const fwd = await c.commentsPage(groupId, probe.postId, { limit: 1, createdGt: aAt });
  if (fwd.threads.length !== 1 || fwd.threads[0].post?.id !== B.id) {
    return `FAIL created-gt did not return the next thread (limit 1): got ${fwd.threads.length} thread(s), first ${fwd.threads[0]?.post?.id ?? "none"}, expected ${B.id}`;
  }
  if (fwd.last !== 0 && fwd.last !== bAt) return `FAIL created-gt page: \`last\` ${fwd.last} is not that thread's created_at ${bAt}`;

  const back = await c.commentsPage(groupId, probe.postId, { limit: 1, createdLt: bAt });
  if (back.threads.length !== 1 || back.threads[0].post?.id !== A.id) {
    return `FAIL created-lt did not return the previous thread (limit 1): got ${back.threads.length} thread(s), first ${back.threads[0]?.post?.id ?? "none"}, expected ${A.id}`;
  }
  if (back.last !== 0 && back.last !== aAt) return `FAIL created-lt page: \`last\` ${back.last} is not that thread's created_at ${aAt}`;

  return "ok (created-gt and created-lt each return the neighbouring thread, limit 1 honoured)";
}
