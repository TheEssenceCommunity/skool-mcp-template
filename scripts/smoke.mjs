// End-to-end smoke test through the real MCP protocol. Usage: node scripts/smoke.mjs [toolName] [jsonArgs]
// Read-only: posts, likes and sends nothing. Connection settings come from .mcp-local.json (see scripts/connect.mjs).
import { connect } from "./connect.mjs";

const client = await connect("smoke");

const [only, argsJson] = process.argv.slice(2);
if (only) {
  const r = await client.callTool({ name: only, arguments: argsJson ? JSON.parse(argsJson) : {} });
  console.log(r.isError ? "ERROR" : "OK", process.env.FULL ? r.content?.[0]?.text : r.content?.[0]?.text?.slice(0, 4000));
  process.exit(0);
}

const tools = await client.listTools();
console.log("tools:", tools.tools.map((t) => t.name).join(", "));

const calls = [
  ["skool_whoami", {}],
  ["skool_community", {}],
  ["skool_list_posts", { limit: 3, contentChars: 80 }],
  ["skool_list_members", { page: 1 }],
  ["skool_search_members", { query: "a", limit: 3 }],
  ["skool_calendar", { limit: 3 }],
  ["skool_list_conversations", {}],
  ["skool_discover_communities", { query: "meditation", sort: "top", limit: 3 }],
  ["skool_community", { community: "earth2" }],
  ["skool_search_posts", { query: "the", limit: 3 }],
  ["skool_notifications", { limit: 5 }],
  ["skool_leaderboard", { period: "7d" }],
  ["skool_list_courses", {}],
];
for (const [name, args] of calls) {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args });
  const txt = r.content?.[0]?.text ?? "";
  let summary = txt.slice(0, 300).replace(/\s+/g, " ");
  try { const o = JSON.parse(txt); summary = Object.entries(o).map(([k, v]) => `${k}=${Array.isArray(v) ? `[${v.length}]` : typeof v === "object" && v ? "{…}" : JSON.stringify(v)?.slice(0, 60)}`).join(" "); } catch {}
  console.log(`${r.isError ? "ERROR" : "OK  "} ${name} (${Date.now() - t0}ms): ${summary}`);
}
