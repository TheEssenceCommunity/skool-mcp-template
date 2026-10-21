// Live write test: create a post, comment on it, then delete both. Members may get a notification before it is deleted.
// Usage: node scripts/write-test.mjs [profile] [labelId]
import { connect } from "./connect.mjs";

const client = await connect("write-test");
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
const post = await call("skool_create_post", { profile, labelId, title: "MCP test (ignore, auto-deleted)", content: "Automated connectivity test. This post deletes itself in a few seconds." });
if (!post.id) throw new Error("no post id returned");
let comment = null;
try { comment = await call("skool_create_comment", { profile, postId: post.id, content: "Testing MCP replies (auto-deleted)." }); }
finally {
  if (comment?.id) await call("skool_delete_post", { profile, postId: comment.id }).catch((e) => console.log("comment delete failed:", e.message));
  await call("skool_delete_post", { profile, postId: post.id });
}
// verify it is gone
const check = await client.callTool({ name: "skool_get_post", arguments: { profile, postSlug: post.slug ?? "x", withComments: false } });
console.log("post lookup after delete:", check.isError ? "gone (expected)" : "STILL PRESENT");
