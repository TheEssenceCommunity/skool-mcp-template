// Look up a community's slug and internal group id, the two values wrangler.toml needs.
// Usage: node scripts/find-group-id.mjs <community URL or slug>
//   e.g. node scripts/find-group-id.mjs https://www.skool.com/my-community-1234/about
// Reads Skool's public About-page data: no login, no token, works for any community.
const arg = process.argv[2];
if (!arg) { console.error("Usage: node scripts/find-group-id.mjs <community URL or slug>"); process.exit(1); }
const slug = arg.replace(/^https?:\/\/(www\.)?skool\.com\//, "").split(/[/?#]/)[0];

// Skool's CDN refuses requests without a browser User-Agent (same value as src/skool.ts).
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const res = await fetch(`https://api2.skool.com/groups/${encodeURIComponent(slug)}`, {
  headers: { "User-Agent": UA, Origin: "https://www.skool.com", Referer: "https://www.skool.com/" },
});
if (!res.ok) { console.error(`Skool answered HTTP ${res.status} for "${slug}". Check the slug (the part of the URL after skool.com/).`); process.exit(1); }
const d = await res.json();
const g = d.group ?? d;
console.log(`Community: ${g.metadata?.display_name ?? "?"}`);
console.log(`SKOOL_DEFAULT_SLUG = "${g.name}"`);
console.log(`SKOOL_DEFAULT_GROUP_ID = "${g.id}"`);

// Sync guard test: this line will be reverted.
