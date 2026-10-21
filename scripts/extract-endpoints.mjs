// Regenerate SKOOL-ENDPOINTS.md from Skool's live web client. Usage: node scripts/extract-endpoints.mjs
//
// Skool has no public API and no docs, so the authority on what api2 offers is Skool's own front end.
// Its apiClient lives in the pages/_app chunk as a class of `async name(){ ... path: "..." ... }` methods;
// this walks them, brace-matching each body so long ones are not truncated, and cross-references the result
// against the endpoints src/skool.ts actually calls.
import { writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const norm = (p) => p.replace(/\$\{[^}]*\}/g, "{id}").replace(/\{[^}]*\}/g, "{id}").replace(/\/+$/, "");
const key = (verb, path) => `${verb} ${norm(path)}`;

/** Brace-match from the first `{` at or after `from`, returning the body including braces. */
function block(src, from) {
  const i = src.indexOf("{", from);
  if (i < 0) return null;
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}" && --depth === 0) return src.slice(i, j + 1);
  }
  return null;
}

/** Paren-match from `from`, returning the argument text between the parens. */
function args(src, from) {
  let depth = 1;
  for (let j = from; j < src.length; j++) {
    if (src[j] === "(") depth++;
    else if (src[j] === ")" && --depth === 0) return src.slice(from, j);
  }
  return null;
}

const home = await (await fetch("https://www.skool.com/", { headers: { "User-Agent": UA } })).text();
const buildId = home.match(/"buildId"\s*:\s*"([^"]+)"/)?.[1] ?? "unknown";
const chunk = home.match(/\/_next\/static\/chunks\/pages\/_app-[^"]*\.js/)?.[0];
if (!chunk) throw new Error("Could not find the pages/_app chunk in Skool's HTML — the page shell changed.");
const src = await (await fetch(`https://www.skool.com${chunk}`, { headers: { "User-Agent": UA } })).text();

// ---- what Skool's client offers ----
const eps = [];
for (const m of src.matchAll(/async ([A-Za-z0-9_$]+)\(/g)) {
  const body = block(src, m.index + m[0].length);
  if (!body || !/path:/.test(body)) continue;
  const pm = body.match(/path:\s*("(?:[^"\\]|\\.)*"(?:\.concat\((?:[^()]|\([^()]*\))*\))?)/);
  if (!pm) continue;
  const path = pm[1]
    .replace(/\.concat\(((?:[^()]|\([^()]*\))*)\)/g, (_, a) =>
      a.split(",").map((x) => { x = x.trim(); return x.startsWith('"') ? x.slice(1, -1) : "{id}"; }).join(""))
    .replace(/"/g, "");
  if (!path.startsWith("/")) continue;
  eps.push({ name: m[1], verb: (body.match(/method:"([A-Z]+)"/) ?? [])[1] ?? "GET", path });
}

// ---- what we already call (api2 only; the Next.js data routes are not part of this surface) ----
const client = readFileSync(join(ROOT, "src/skool.ts"), "utf8");
const ours = new Set();
for (const m of client.matchAll(/this\.api2\(/g)) {
  const call = args(client, m.index + m[0].length);
  const pm = call?.match(/^\s*[`"']([^`"']+)[`"']/);
  if (pm) ours.add(key((call.match(/method:\s*"([A-Z]+)"/) ?? [, "GET"])[1], pm[1]));
}

const GROUPS = [
  [/^\/posts/, "Posts, comments, likes"],
  [/^\/polls/, "Polls"],
  [/^\/groups/, "Communities (read + admin)"],
  [/^\/(members|membership)/, "Members and memberships"],
  [/^\/self/, "The signed-in account"],
  [/^\/users/, "Other users"],
  [/^\/(channels|chat)/, "Direct messages"],
  [/^\/files/, "Files and attachments"],
  [/^\/(courses|modules|lessons|videos)/, "Classroom"],
  [/^\/(billing|payment|stripe|subscriptions|invoices)/, "Billing and payments"],
  [/^\/affiliates/, "Affiliates"],
  [/^\/search/, "Search"],
  [/^\/(notifications|emails)/, "Notifications and email"],
];
const buckets = new Map();
for (const e of eps) {
  const label = GROUPS.find(([re]) => re.test(e.path))?.[1] ?? "Other";
  if (!buckets.has(label)) buckets.set(label, []);
  buckets.get(label).push(e);
}
const order = [...GROUPS.map(([, l]) => l), "Other"].filter((l) => buckets.has(l));

let have = 0;
let tables = "";
for (const label of order) {
  const rows = buckets.get(label).sort((a, b) => a.path.localeCompare(b.path) || a.verb.localeCompare(b.verb));
  tables += `### ${label}\n\n| | method | endpoint | \`apiClient\` |\n|---|---|---|---|\n`;
  for (const r of rows) {
    const mine = ours.has(key(r.verb, r.path));
    if (mine) have++;
    tables += `| ${mine ? "✅" : ""} | \`${r.verb}\` | \`${r.path}\` | \`${r.name}\` |\n`;
  }
  tables += "\n";
}
const extra = [...ours].filter((k) => !eps.some((e) => key(e.verb, e.path) === k));

writeFileSync(join(ROOT, "SKOOL-ENDPOINTS.md"), `# Skool api2 endpoint inventory

**${eps.length} endpoints**, extracted from Skool's own web client on ${new Date().toISOString().slice(0, 10)}
(buildId \`${buildId}\`, chunk \`${chunk.split("/").pop()}\`). Regenerate with \`node scripts/extract-endpoints.mjs\`.

Skool has no public API and no documentation, so its front end is the authority on what \`api2.skool.com\`
offers. This is that list, so the answer to "does Skool have an endpoint for X" is a lookup rather than a
guess — which is the failure mode \`skool_raw_get\` exists to prevent.

✅ marks the ${have} rows \`src/skool.ts\` already calls, matched on method **and** path.

**Read this as a floor, not a ceiling.** It is what Skool's web client happens to call, not everything api2
accepts${extra.length ? ` — we already rely on ${extra.map((e) => `\`${e}\``).join(", ")}, which appears nowhere in it (Skool's own client reads a post via \`GET /groups/{name}/post-detail\` instead)` : ""}. Absence from this
table is a reason to test, not proof of nothing there.

Not included: the Next.js data routes (\`/_next/data/{buildId}/…\`), which are a separate surface backing the
feed, members, calendar, search, leaderboard and classroom pages — see \`src/skool.ts\` for those.

An endpoint being listed here says nothing about whether it *should* be wired up. See NOTES.md's
"Admin endpoints deliberately not implemented" for the ones left out on purpose. The list is exhaustive
because it is mechanically extracted, so it also contains credential, billing and destructive routes
(\`/auth/*\`, \`/billing/*\`, group and account deletion). Those are inventory, not a menu — none belong
behind an MCP tool.

${tables}`);

console.log(`${eps.length} endpoints, ${have} implemented, ${buckets.size} groups -> SKOOL-ENDPOINTS.md`);
if (extra.length) console.log("used here but absent from Skool's client:", extra.join(", "));
