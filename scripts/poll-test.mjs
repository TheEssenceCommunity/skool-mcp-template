// Live poll write test: create a poll post, verify pollId came back, then delete it.
// Usage: node scripts/poll-test.mjs [profile] [labelId]
import { connect } from "./connect.mjs";

const client = await connect("poll-test");
const profile = process.argv[2] ?? "main";
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const txt = r.content?.[0]?.text ?? "";
  console.log(`${r.isError ? "ERROR" : "OK  "} ${name}: ${txt.slice(0, 500).replace(/\s+/g, " ")}`);
  if (r.isError) throw new Error(txt);
  try { return JSON.parse(txt); } catch { return {}; }
};

// A category id from skool_community (needed in communities that enforce categories). Optional second argument.
const labelId = process.argv[3];
const poll = await call("skool_create_poll", {
  profile,
  labelId,
  title: "MCP poll test (ignore, auto-deleted)",
  content: "Automated connectivity test. This poll deletes itself in a few seconds.",
  options: ["Option A", "Option B"],
});
if (!poll.pollId) throw new Error("no pollId returned");
if (!poll.id) throw new Error("no post id returned");
console.log(`pollId=${poll.pollId} postId=${poll.id}`);
await call("skool_delete_post", { profile, postId: poll.id });

// verify it is gone
const check = await client.callTool({ name: "skool_get_post", arguments: { profile, postSlug: poll.slug ?? "x", withComments: false } });
console.log("post lookup after delete:", check.isError ? "gone (expected)" : "STILL PRESENT");
