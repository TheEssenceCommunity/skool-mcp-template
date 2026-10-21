// Read-only check that every comment on a post is reachable through skool_get_comments paging.
// Usage: node scripts/comments-test.mjs [postId] [community]
// Defaults to a public post known to have 175 comments, one of them in a pinned thread (checked 2026-10-10).
// Posts, likes and edits nothing. Point MCP_BASE at a local bundle to test before deploying (see the README, "Test changes before deploying").
import { connect } from "./connect.mjs";

const POST = process.argv[2] ?? "60693b8629d044a1b22f36d806732ea6";
const COMMUNITY = process.argv[3] ?? (process.argv[2] ? undefined : "skoolers");
const CAP = 25_000;

const client = await connect("comments-test");

let failed = 0;
const check = (ok, label, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`); if (!ok) failed++; };

async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  const txt = r.content?.[0]?.text ?? "";
  let json = null; try { json = JSON.parse(txt); } catch {}
  return { isError: !!r.isError, txt, json };
}
const ids = (threads, out = []) => { for (const t of threads ?? []) { out.push(t.id); ids(t.replies, out); } return out; };
const base_ = { postId: POST, ...(COMMUNITY ? { community: COMMUNITY } : {}) };

async function walk(label, args) {
  const seen = [], created = [], pages = [];
  let cursor, total = null, oversized = 0, guard = 0;
  for (;;) {
    const r = await call("skool_get_comments", { ...base_, ...args, ...(cursor ? { cursor } : {}) });
    if (r.isError || !r.json) { check(false, `${label}: page ${pages.length + 1} readable`, r.txt.slice(0, 200)); break; }
    const j = r.json;
    if (r.txt.length > CAP) oversized++;
    total = j.totalComments;
    const page = [...ids(j.pinned), ...ids(j.comments)];
    seen.push(...page);
    created.push(...(j.comments ?? []).map((t) => t.createdAt));
    pages.push({ threads: j.count, comments: j.commentsInPage, chars: r.txt.length, trimmed: !!j.trimmedForSize, hasMore: j.hasMore, pinned: ids(j.pinned).length });
    if (!j.hasMore) { check(j.nextCursor === undefined, `${label}: final page carries no nextCursor`); break; }
    cursor = j.nextCursor;
    if (++guard > 80) { check(false, `${label}: terminates`, "more than 80 pages"); break; }
  }
  const unique = new Set(seen);
  console.log(`      ${label}: ${pages.length} pages [${pages.map((p) => `${p.threads}t/${p.comments}c/${p.chars}ch${p.trimmed ? "·trim" : ""}`).join(" ")}]`);
  check(unique.size === seen.length, `${label}: no comment returned twice`, `${seen.length} returned, ${unique.size} unique`);
  check(total !== null && seen.length === total, `${label}: every comment reached`, `${seen.length} of Skool's counter ${total}`);
  check(pages.reduce((n, p) => n + p.comments, 0) === seen.length, `${label}: commentsInPage adds up`);
  check(oversized === 0, `${label}: no page over the ${CAP}-char cap`, `largest ${Math.max(...pages.map((p) => p.chars))}`);
  return { seen: unique, created, pages };
}

// 1. oldest-first at Skool's maximum page size
const oldest = await walk("oldest limit=30", { limit: 30 });
check(oldest.created.every((t, i, a) => i === 0 || Date.parse(t) >= Date.parse(a[i - 1])), "oldest: threads run oldest to newest across pages");

// 2. newest-first at a small page size
const newest = await walk("newest limit=10", { limit: 10, order: "newest" });
check(newest.created.every((t, i, a) => i === 0 || Date.parse(t) <= Date.parse(a[i - 1])), "newest: threads run newest to oldest across pages");
check(newest.seen.size === oldest.seen.size && [...oldest.seen].every((i) => newest.seen.has(i)), "both directions reach the identical set of comments");

// 3. an unparameterised call still behaves, and says it is partial
const dflt = await call("skool_get_comments", base_);
check(!dflt.isError && dflt.json?.count === 10 && dflt.json?.hasMore === true && /^after:\d+$/.test(dflt.json?.nextCursor ?? "") && /skool_get_comments/.test(dflt.json?.next ?? ""),
  "default call: 10 threads, hasMore, nextCursor and a next hint", dflt.json && `count=${dflt.json.count} hasMore=${dflt.json.hasMore}`);
if (!process.argv[2]) {
  // The default post has exactly one pinned thread (1 comment + 6 replies); it must come with page one only.
  check(ids(dflt.json?.pinned).length === 7, "pinned thread (7 comments) comes with the first page", `${ids(dflt.json?.pinned).length} seen`);
  check(oldest.pages.slice(1).every((p) => p.pinned === 0), "pinned thread is not repeated on later pages");
}

// 4. attachments are compact unless asked for
const att = (ts, out = []) => { for (const t of ts ?? []) { out.push(...(t.attachments ?? [])); att(t.replies, out); } return out; };
const compact = att(oldest.pages.length ? (await call("skool_get_comments", { ...base_, limit: 30 })).json.comments : []);
check(compact.length === 0 || compact.every((a) => !("url" in a) && "type" in a && "fileName" in a), "attachments default to type + fileName only", `${compact.length} seen`);
const full = att((await call("skool_get_comments", { ...base_, limit: 30, attachmentUrls: true })).json?.comments);
check(full.length === 0 || full.every((a) => "url" in a), "attachmentUrls:true restores the full records", `${full.length} seen`);

// 5. skool_get_post points at the rest instead of stopping silently
const gp = await call("skool_get_post", { postId: POST, ...(COMMUNITY ? { community: COMMUNITY } : {}) });
check(!gp.isError && gp.txt.length <= CAP, "skool_get_post fits the output cap", `${gp.txt.length} chars`);
check(gp.json?.commentsPage?.hasMore === true && /^after:\d+$/.test(gp.json?.commentsPage?.nextCursor ?? "") && /skool_get_comments/.test(gp.json?.commentsPage?.next ?? ""),
  "skool_get_post flags a partial thread and names the next call");

// 6. misuse is refused clearly
const bad = await call("skool_get_comments", { ...base_, cursor: "banana" });
check(bad.isError && /Invalid cursor/.test(bad.txt), "a malformed cursor is refused with an explanation");
const clash = await call("skool_get_comments", { ...base_, cursor: "after:1778694085437557", order: "newest" });
check(clash.isError && /direction/.test(clash.txt), "a cursor plus a conflicting order is refused");
const big = await call("skool_get_comments", { ...base_, limit: 31 });
check(big.isError, "limit above Skool's ceiling of 30 is refused");

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
await client.close();
process.exit(failed ? 1 : 0);
