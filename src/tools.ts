import { McpServer } from "@modelcontextprotocol/server";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import { z } from "zod";
import { type Env, type Profile, profilesOf, tokenFor } from "./env";
import { SkoolClient, SkoolError, vttToText } from "./skool";
import * as N from "./normalize";
import { latestProgress } from "./progress";
import { runAnalytics, VIEWS, CHARTS, DEFAULT_CHARTS, STATUSES, MEMBER_FIELDS, DEFAULT_FIELDS, MAX_ROWS } from "./analytics";
import { readCommentsPage, commentTotal, pageFields, DEFAULT_THREADS_PER_PAGE, MAX_THREADS_PER_PAGE } from "./comments";

const MAX_CHARS = 25_000;
// Keys, paging hints and the pinned/post fields that sit around a page of comments in the response.
const COMMENTS_ENVELOPE = 1_500;
// A very long post body must not starve its own comment thread down to nothing.
const MIN_COMMENTS_BUDGET = 4_000;
// Cloudflare caps a Worker request at 50 subrequests (measured on this account 2026-09-07, hard limit).
// Two are spent on the Mux manifests, so 45 caption segments (~22 min of video) is the safe ceiling per call.
const MAX_CAPTION_SEGMENTS = 45;

/**
 * Sent once at connection, so every session pays for it — keep it to what every session needs:
 * what exists (so nothing is wrongly declared impossible) and what cannot be undone.
 * Everything else lives in USAGE_GUIDE, fetched on demand via skool_usage_guide.
 */
const SERVER_INSTRUCTIONS = `Skool MCP — orientation. This is only what every session needs up front; run skool_usage_guide for the full mechanics.

WHAT THIS SERVER COVERS — read this before concluding a capability is missing
- Feed and posts: list the feed, read one post, search the whole post archive, publish, delete.
- Comments: read a thread, comment, reply inside a thread.
- Likes: like or unlike a post OR a comment, and list who liked one.
- GIFs: search GIFs and attach one to a post, a poll, a comment, or a DM (with or without text).
- Editing: rewrite the title or body of a post or comment you own, after publishing.
- Polls: publish a post with a poll, optionally with a GIF; results come back attached to the post.
- Members: directory, search by name, join requests with their answers, approve.
- DMs: inbox (naming who each thread is with), read a thread, send to a channel or straight to a member, mark read.
- Calendar: upcoming and past events.
- Classroom: courses, a course outline, one lesson's text, the spoken transcript of a lesson video — and
  building courses: create a course, section or lesson (always as a draft), write titles and lesson bodies,
  attach a YouTube video, and publish or unpublish any of them.
- Activity: notifications across every community the account is in, the leaderboard, rules and levels.
- Analytics (admin profile only): active members (daily/weekly/monthly), daily activity, every Dashboard and
  Growth chart, join sources and referrers over any dates, who joined/left, paying members and income, every
  member's course progress (lessons completed per course), and a weekly snapshot — all in skool_analytics, which
  returns only the views asked for.
- Other communities: search Skool's public directory, read any community's About page, and read the feed of
  any community whose publicFeed is true — all without joining.
If the task looks like anything above, THE TOOL EXISTS. Look it up by what it does rather than assuming it is
missing because you did not see its name. Never answer "this server cannot do that" for anything on this list.
skool_raw_get is a debugging fallback, NOT a way to reach features — never guess Skool URLs for the above.

BEFORE ANY WRITE (post, poll, comment, DM, delete, approve, like, classroom create/edit/publish)
- Show the user the exact text and which account will act, then wait for their yes.
- Publishing classroom content puts it in front of members: name the exact item and get an explicit yes.
- A like is a write too: it notifies the author, and unliking does NOT un-notify. Never bulk-like a feed —
  Skool rate-limits it and it reads as botting.
- \`profile\` chooses the acting account and is required on writes. Never guess it; ask.
- WRITES ARE NOT UNDOABLE. Deleting a post or comment does not retract the notification Skool already sent,
  and posting notifies that account's followers. "I can just delete it" is not a safety net.
- Tagging: write [@Full Name](obj://user/<userId>). THE ID IS WHAT TAGS — the name is only a label, so a wrong
  id silently tags the wrong member and notifies them. Take ids from a lookup in this session, never memory.

RUN skool_usage_guide BEFORE
- reading or building courses, lesson transcripts, searching old posts, browsing communities the account has
  not joined, or creating a poll — each has a mechanic that cannot be guessed;
- and whenever a result looks empty or wrong: a comment with no text is almost always a GIF, not an error.

ERRORS: [auth] token or permission; [edge] Skool's CDN blocked it; [notfound] bad id/slug; [ratelimit] wait and
retry; [http]/[parse] Skool changed something — report it. Output is capped at 25k chars; paginate if truncated.`;

/** Stable how-to guidance. Mechanisms only — no community names or other facts that change (ask skool_whoami for those). */
const USAGE_GUIDE = `Skool MCP — how to use these tools

WHAT THIS SERVER COVERS — read this before concluding a capability is missing
- Feed and posts: list the feed, read one post, search the whole post archive, publish, delete.
- Comments: read a thread, comment, reply inside a thread.
- Likes: like or unlike a post OR a comment, and list who liked one.
- GIFs: search GIFs and attach one to a post, a poll, a comment, or a DM (with or without text).
- Editing: rewrite the title or body of a post or comment you own, after publishing.
- Polls: publish a post with a poll, optionally with a GIF; results come back attached to the post.
- Members: directory, search by name, join requests with their answers, approve.
- DMs: inbox (naming who each thread is with), read a thread, send to a channel or straight to a member, mark read.
- Calendar: upcoming and past events.
- Classroom: list courses, a course outline, one lesson's text, the spoken transcript of a lesson video — and
  building courses: create a course, section or lesson (always as a draft), write titles and lesson bodies,
  attach a YouTube video, and publish or unpublish any of them.
- Activity: notifications across every community the account is in, the leaderboard, rules and levels.
- Analytics (admin profile only): active members (daily/weekly/monthly), daily activity, every Dashboard and
  Growth chart, join sources and referrers over any dates, who joined/left, paying members and income, every
  member's course progress (lessons completed per course), and a weekly snapshot — all in skool_analytics, which
  returns only the views asked for.
- Other communities: search Skool's public directory, read any community's About page, and read the feed of
  any community whose publicFeed is true — all without joining.
If the task looks like anything above, THE TOOL EXISTS. Look it up by what it does rather than assuming it is
missing because you did not see its name. Never answer "this server cannot do that" for anything on this list,
and never fall back to raw HTTP for it.

PROFILES
- Every tool takes \`profile\`: which Skool account acts. Reads default to the first profile configured on the server (the \`profile\` parameter lists them all). Writes require the profile explicitly; never guess it — ask the user if unclear.
- A profile reaches exactly the communities its account is a member of. Run skool_whoami with that profile to list them; do not assume. If a read fails with [auth] for one profile, try another before concluding the token is dead — the likelier cause is that this account is not a member, or not an admin, of that community.
- Admin-only tools (labels via skool_community, skool_pending_members, skool_approve_member) only work for a profile that is an admin of that community. Declining an applicant is deliberately NOT exposed — if the user wants someone declined, tell them to do it in Skool.

COMMUNITIES
- Every tool takes an optional \`community\` slug (the part of the URL after skool.com/). Omitted = the default community configured on the server. Pass it for any other community the profile belongs to.

READING
- skool_list_posts pages the feed (~30 per page); skool_get_post returns one post with the first page of its comment thread; skool_get_comments pages the whole thread (see READING A LONG COMMENT THREAD).
- skool_list_members pages the directory (30/page). includeEmail only when the user explicitly needs emails; includeAnswers adds each member's join-application answers.
- skool_pending_members returns applicants with their answers and the membershipId that skool_approve_member needs.

EMPTY COMMENTS ARE USUALLY GIFS — NOT AN ERROR
- A comment can come back with content: "" and still be a perfectly normal comment. On Skool a GIF, image
  or video is an attachment, not text, so a comment whose whole message is a GIF carries no text content at
  all. In a warm community this is common, not an edge case — most often a Giphy GIF, sometimes a photo or
  video, and sometimes just an @mention with a GIF under it.
- Never report this as an error, a failed read, a deleted comment, or "the tool returned nothing". Read it as
  what it is: the member replied with a GIF.
- Check the \`attachments\` field, which appears on a comment or post only when something is attached:
  [{ id, type: "image/gif", fileName: "biting-nails.gif", url: "https://media1.giphy.com/…/200.gif", thumbnailUrl }].
  Inside comment threads (skool_get_post, skool_get_comments) each attachment is shortened to
  { type, fileName } because the GIF urls are very long and eat the output cap; pass attachmentUrls: true to
  skool_get_comments for the full record above.
  \`type\` is the MIME type, so image/gif vs image/jpeg vs video/* tells you which it is, and \`fileName\` is
  usually descriptive enough to convey the intent of the GIF ("welcom.gif", "lets-go.gif") without fetching it.
  A separate \`videoIds\` field means a Skool-hosted video is embedded.
- DMs behave identically: a message carries a GIF as an attachment, so a GIF-only DM has no text either.
  One quirk on the inbox listing — skool_list_conversations returns the attachment's id but not its record,
  because Skool omits attachments_data there, so type/fileName/url come back null. That still says something
  is attached; read the thread with skool_get_conversation to see what it actually is.
- If content is empty AND there is no attachments field, that is the genuinely unusual case worth mentioning.
- When summarising a thread for the user, count these as real engagement and say what they were (e.g. "three
  replies, one of them a GIF"), rather than silently dropping them.

READING A LONG COMMENT THREAD — IT COMES IN PAGES, SO CHECK hasMore BEFORE SAYING YOU HAVE READ IT
- A post's comment thread is paged. skool_get_post returns only the first page (with the post body), and a page
  of skool_get_comments is at most \`limit\` top-level threads (default 10, Skool's ceiling is 30), each with its
  replies nested. A post's \`commentCount\` counts every comment AND reply, so it is larger than the threads shown.
- Every comment response says where it stands: \`totalComments\` (Skool's own counter), \`count\` (threads on this
  page), \`commentsInPage\` (comments on this page, replies included), \`hasMore\`, and when there is more a
  \`nextCursor\` plus a \`next\` sentence naming the call. skool_get_post carries the same fields under \`commentsPage\`.
- To read all of it: call skool_get_comments with the postId, then call it again with \`cursor\` set to the previous
  \`nextCursor\`, until \`hasMore\` is false. Pass the cursor back exactly as returned (it looks like
  after:1778694085437557); it already carries its direction, so do not also pass \`order\`.
- \`order\`: "oldest" (default) starts at the first comment; "newest" starts at the latest and walks back, which is
  the right way to answer "what has been said lately" on a long post without reading all of it.
- A page can hold fewer threads than \`limit\`: it is cut to fit the 25k-character output cap, \`trimmedForSize\` says so,
  and \`nextCursor\` still continues exactly where it stopped. A long post therefore takes several calls.
- The post's pinned comment thread is not part of the normal list. It comes back separately as \`pinned\` (in
  skool_get_post, \`pinnedComments\`) on the FIRST page only, and is not repeated. Add it to the pages to reach
  \`totalComments\`; on the one post checked, 168 listed + 7 pinned = 175.
- \`totalComments\` is Skool's own counter. On the one post checked it matched the readable total exactly. If a
  thread ever ends short of it, report both numbers and say so, rather than guessing why or looping for more.
- Reading comments is read-only and posts, likes or edits nothing, however many pages are fetched.

POSTING A GIF — TWO STEPS, AND THE URL MUST BE A REAL SEARCH RESULT
- Skool does not host GIFs. Its picker queries Giphy and stores only a reference, so posting one is:
  skool_search_gifs -> CHOOSE a result by its title -> pass that whole row as \`gif\` to skool_create_post,
  skool_create_poll or skool_create_comment. The tool registers the file and attaches it in one go.
- Pass the row through UNCHANGED. The url must come from a search in this session: a Giphy link written from
  memory or assembled by hand does not resolve, and the post publishes with a broken attachment.
- Choosing matters. The titles are there so the GIF actually fits what is being said — taking result [0] every
  time is how you end up welcoming a new member with something off-key. Use \`offset\` to see more options.
- A comment may be a GIF with no text at all; \`content\` is optional when \`gif\` is given. On a post, the title
  and body are still required — the GIF sits under them. skool_create_poll takes \`gif\` the same way (title and
  options still required). skool_send_message takes \`gif\` the same way, though the DM is permanent once sent,
  so be surer of a GIF there than anywhere else.
- A GIF can only be attached WHEN PUBLISHING. skool_edit_post changes title and content only, so a post or poll
  published without its GIF cannot get one added through these tools — decide on the GIF before publishing.
- Skool deletes a registered GIF file that no post references, so a file id cannot be created ahead of time
  and reused later. That is why there is no separate "upload" tool.

LIKES
- skool_like takes a post id OR a comment id — Skool models a comment as a post, so both work identically.
- It reads the current state first, so liking something already liked reports changed:false rather than
  silently unliking it. Reads carry \`likedByMe\` and \`upvotes\` on every post and comment.
- A like notifies the author, and unliking does NOT retract that notification. It is a write: confirm which
  account is liking, and never sweep a feed liking everything — Skool answers 429 ("Liking too fast"), and to
  members it reads as botting rather than attention.
- skool_post_likers lists who liked something. Worth checking before concluding someone has gone quiet: people
  who like often but rarely comment are invisible in a thread read and on the leaderboard.

COMMUNITIES THE ACCOUNT HAS NOT JOINED
- skool_discover_communities searches Skool's public directory (topic, price, size, language, sort). Start here
  when the user wants to FIND communities rather than read their own.
- skool_community reads any community's About page by slug — the long About body, price, size,
  courses, rating, the questions asked of applicants, the owner. No membership and no auth needed.
- Each discovery result carries publicFeed. When it is true, that community's feed is readable immediately:
  pass its slug as \`community\` to skool_list_posts / skool_get_post / skool_get_comments, exactly as for a
  joined community. When it is false, only the About page is visible and a feed read fails with [auth].
- The slug is the URL segment (e.g. "earth2"), never the display name ("Earth 2.0 Community"). Take it from
  the discovery results; guessing it from the name usually 404s.
- Reading is all these tools do here. Joining, paying, or applying to a community is the user's own action —
  never attempt it.

SEARCH
- skool_search_posts is the ONLY way to reach posts older than the recent feed. skool_list_posts walks the
  feed from the newest end, so in a community with many posts everything older is unreachable without search.
- skool_get_post takes either postSlug or postId, and postId now resolves at any age.

CLASSROOM / COURSES
- Order of operations: skool_list_courses (get the course slug) -> skool_get_course (the outline) ->
  skool_get_lesson (one lesson's content) -> skool_get_transcript (what was actually said on the video).
- The course slug is a short opaque URL segment like "a6f22441", NOT the course title. Take it from
  skool_list_courses; it cannot be guessed from the name.
- A course is a tree: course -> section -> lesson. The outline from skool_get_course gives lesson ids,
  titles and whether each has a video.
- Lesson bodies are NOT in the outline. Skool only returns a lesson's text when that lesson is the selected
  module, so reading a course's content costs one skool_get_lesson call per lesson. This is expected — do not
  conclude the lessons are empty because the outline has no text in it.
- Lesson bodies are stored as ProseMirror JSON behind a "[v2]" prefix; skool_get_lesson renders that to
  markdown for you. Never try to read the raw field.

BUILDING COURSES (create, edit, publish)
- Three tools, all needing a profile that is an admin of the community:
  skool_create_course_item (a new course, section or lesson), skool_edit_course_item (change one that exists),
  skool_set_published (publish or unpublish one).
- Typical order: create the course -> take courseSlug from the result -> create sections -> create lessons inside
  them (sectionId) or directly in the course -> check with skool_get_course -> publish once the user says so.
- EVERYTHING IS CREATED AS A DRAFT. Members cannot see a draft, so creating and editing drafts is safe to do
  step by step. Going live is only ever skool_set_published.
- Members see an item only when it AND every section and course above it are published. Publishing does not
  cascade either way: publishing a course does not publish its draft lessons, and publishing a lesson inside a
  draft course keeps it hidden. skool_set_published reports visibleToMembers and names any draft parent in
  hiddenBy; skool_get_course shows \`published\` on every item.
- Publishing is the outward-facing step. Name the exact item(s) and get an explicit yes before each call.
  Unpublishing hides content members may be partway through, so ask before that too. Skool's editor has no
  notify option for publishing and no notification was seen in testing, but only drafts could be tested.
- Titles: max 50 characters (an emoji counts as one); Skool refuses longer ones and writes nothing.
- Lesson body: markdown — #### headings, paragraphs, "- " bullets, "1. " numbered items, **bold**, *italic*,
  \`code\`, [text](url), "---" rule. A single newline inside a paragraph becomes a line break; a blank line
  starts a new paragraph. On edit the body REPLACES the whole existing body. A course's "body" is instead its
  short plain-text description (max 500).
- Video: pass a YouTube link as videoUrl (on create or edit). Its length and thumbnail are looked up for you, and a
  link to a video that does not exist is refused before anything is written. videoUrl "" removes a linked video.
  Only YouTube is supported. A video UPLOADED to Skool is left alone — replace or remove that in Skool itself.
- Edits are partial: only what is passed changes, and resources, transcript and publish state are never touched.
  Editing sends no notification, but on a published item members see the change at once. The edit returns the
  previous values so it can be put back.
- New items go at the end of their course or section. Reordering, moving between sections, access locks
  (level, price, time, tier), cover images, resources and DELETING are not done by these tools — those stay in
  Skool. (Deleting a course needs an emailed verification code, so it cannot be done from the server at all.)

VIDEO TRANSCRIPTS
- Lesson videos are auto-captioned. Skool also has its own transcript field, but it is usually empty;
  skool_get_transcript returns it when set and falls back to the captions otherwise.
- FIRST decide which route you are on, because they differ a lot:

  (a) YOU HAVE A SHELL (Claude Code, or anywhere you can run curl). Do it in one pass, no paging and no
      size limit. Call skool_get_transcript once, take manifestUrl from the response, then:
        curl -s -H "Referer: https://www.skool.com/" "<manifestUrl>" \\
          | grep -o 'URI="[^"]*subtitles[^"]*"' | cut -d'"' -f2 > /tmp/sub.txt
        curl -s -H "Referer: https://www.skool.com/" "$(cat /tmp/sub.txt)" | grep -v '^#' | grep . > /tmp/segs.txt
        mkdir -p /tmp/vtt && rm -f /tmp/vtt/*.vtt
        # Number the output files. Segments are pre-signed (no headers) and safe to fetch in parallel, but
        # xargs -P interleaves stdout, so writing to numbered files is what keeps the transcript in order.
        nl -w5 -n rz /tmp/segs.txt | xargs -P 8 -n 2 sh -c 'curl -s "$1" > /tmp/vtt/"$0".vtt'
        cat /tmp/vtt/*.vtt | grep -v -e '^WEBVTT' -e '\-\->' -e '^[0-9]*$' -e '^X-TIMESTAMP' -e '^$' \\
          | awk '$0 != prev; {prev=$0}' | tr '\\n' ' ' > /tmp/transcript.txt
      The awk step drops the duplicate cues HLS repeats across segment boundaries.
      The two manifest fetches REQUIRE the Referer header; the segments do not. Tokens last about 24h, so
      re-run skool_get_transcript for a fresh manifestUrl if you get a 403.

  (b) NO SHELL (Claude web, mobile, or any chat surface). Use the tool's own paging: one call covers about
      22 minutes of video. If the response has nextStartSegment, call again with it, repeat until it is
      null, and join the parts in order. totalSegments and coveredSegments tell you where you are. This is
      a Cloudflare limit on the server, not a Skool one - nothing is wrong when it pages.

  (c) A LONG VIDEO AND NO SHELL, and the paging is impractical (several hours of recording, say). Say so
      and suggest running it from Claude Code, or asking someone on the team who can - route (a) does the
      whole thing in seconds regardless of length.

- These are machine-generated captions: expect [Music], [BLANK_AUDIO] and occasional mis-hearings, and say
  so if you quote them as if they were someone's exact words.
- If a video has no caption track the transcript comes back empty with a note. That is not an error.

POLLS
- skool_create_poll publishes a post with a poll on it. A poll is a separate object that only becomes
  visible once a post references it, so the tool does both steps for you - never try to create a bare poll.
- It publishes immediately and notifies followers, exactly like any other post. Confirm the question, the
  options and the profile with the user first. These tools cannot edit a poll's options afterwards, and
  deleting the post does not retract the notification — so get the wording right before publishing.
- It takes an optional \`gif\` (a skool_search_gifs row, passed through unchanged — see POSTING A GIF), attached
  to the poll's post at publish time. It cannot be added later: skool_edit_post does not touch polls or GIFs.
- Read results back with skool_get_post or skool_list_posts: any post carrying a poll returns a \`poll\`
  field with each option's text, vote count and the members who voted for it. Those voter lists are named
  members — report who voted only when the user actually asked, not by default.

NOTIFICATIONS AND ACTIVITY
- skool_notifications spans every community the account belongs to and is the quickest answer to "what
  happened while I was away". Each item carries the post id and a link, so follow up with skool_get_post.
- skool_leaderboard shows the most active members over 7 days, 30 days and all time, plus how members are
  spread across the community's levels — useful for noticing who has gone quiet as well as who is active.
- skool_community also returns the community rules and the level ladder.

WRITING (post, poll, comment, like, edit, delete, DM, approve, classroom — see BUILDING COURSES)
- Always show the user the exact text and the profile before calling a write tool, and wait for their yes.
- WRITES ARE NOT REALLY UNDOABLE. Deleting a post or comment takes it off the feed but does NOT retract the
  notifications Skool already sent — members keep a notification that now leads nowhere. Treat anything you
  write as seen the moment it lands, and never rely on "I can just delete it" as a safety net.
- Posting notifies everyone who follows that account, regardless of any notify setting.
- Choose the profile deliberately. Writing as the wrong account cannot be undone by deleting, because the
  notification already went out under that name. If the user has not named the profile, ask.
- Posts need a category (labelId) in communities that enforce one. labelIds come from skool_community,
  which reads them from an ADMIN-only endpoint: a profile that is not an admin of that community gets
  [auth] HTTP 401 there. If the posting profile is not an admin, fetch the labelId with a profile that is,
  then post as the intended one. A comment needs no labelId, so this never blocks commenting.
- Comments: postId from a listing; parentCommentId to reply inside a thread instead of at the top level.
- Polls: skool_create_poll publishes the post and its poll together — see POLLS.
- DMs: skool_list_conversations -> channelId -> skool_get_conversation / skool_send_message. Each conversation
  names who it is \`with\`. skool_send_message also takes a userId directly and reuses any existing thread.
  DMs cannot be deleted at all, by anyone — not even the recipient. Treat one as permanent the moment it lands.
- skool_delete_post is irreversible and only works on content the profile owns.
- skool_edit_post rewrites a published post or comment. It sends NO notification, so nobody is told the words
  changed — which cuts both ways: a typo fix is invisible, and so is a change of meaning. It returns the
  previous title and content, so an edit can be put back. Pass only the fields that should change.

@MENTIONS — TAGGING SOMEONE
- Write [@Full Name](obj://user/<userId>) inside the text of a post or comment.
- This is verified, not assumed (tested live 2026-09-07): Skool's own editor serializes a tag to exactly this
  string in the same content field, so a tag written through these tools is indistinguishable from a human's.
  It renders as a real tag and fires a real notification.
- THE ID IS WHAT TAGS. The text inside [@...] is only a display label; Skool resolves the person from
  obj://user/<userId>. The right name with the wrong id silently tags the wrong member, and that member gets
  the notification. NEVER guess a userId, never reuse one from memory, and never carry one across
  communities — take it from skool_search_members, a member listing, or the author record of a real post or
  comment, fetched in this same session.
- Tagging always notifies, and deleting afterwards does not take it back. Do not tag anyone in a test post,
  and do not tag people "helpfully" when the user did not ask for it.

ANALYTICS (skool_analytics)
- ONE tool for everything in Skool's admin analytics. Admin-only: only a profile that is an admin of the community
  works (the others get [auth] 401). Read-only.
- Pick what comes back with \`views\` — nothing else is fetched:
  snapshot (default) = the weekly check-in record: the three member counts, average/min/max daily active and weekly
    and monthly active for a 7-day window ending yesterday (or from/to), activity, joined and left with sources,
    paying count and monthly income (minus excludeHandles), started paying, cancelling, and last-30-days visitors
    and signups by source, and course progress counts.
  overview = active members (daily, weekly, monthly + 30-day series), daily activity, Dashboard and Growth headlines.
  charts   = Skool's charts by name (\`charts\`; default a short list, not all 16).
  sources  = joins by source / detail / referrer from member records, for ANY from–to window, plus departures.
  members  = filtered members (status, tier, source, joinedAfter/Before, minLevel). summary:true (default) returns
             counts only; summary:false returns rows with only the \`fields\` asked for, \`limit\`/\`page\`, newest join first.
  paid     = paying members and monthly income; rows only with summary:false.
  courses  = every member's lessons completed per course: distribution, started, finished, median; rows (name and
             "5 of 9" per course) only with summary:false. Read from a nightly collection (06:00–08:00 UTC, on
             Cloudflare), so it is up to a day old and says when it was taken. It is a COUNT per course, not which
             lessons. Skool keeps no history, so the weekly snapshot (which includes the counts) is the record of change.
             excludeHandles leaves people out of these counts too.
             HOW A LESSON GETS MARKED DONE depends on its video (tested 2026-10-11): an UPLOADED video ticks
             automatically at 90% (reaching it, not watching: scrubbing counts); a YouTube link ticks only when the
             member presses Done, so those counts are a floor. Loom, Vimeo and other linked providers are counted
             separately (lessonsByVideo.linkedOther) and are untested — assume Done-button until checked.
- THE WORD "MEMBERS" MEANS THREE COUNTS. Members-page Active tab (no admin accounts — the one the weekly tracker
  logs), About page (admins included), Dashboard daily total (admins included, a once-a-day snapshot that lags
  same-day joins and departures). Every response labels which is which; never report a bare "members" figure.
- "Active members" is likewise three numbers (daily, weekly, monthly). Name which one.
- Skool keeps only 30 days of the Dashboard series and the by-source charts are a rolling last 30 days with no
  daily split — never call those "this week". Joins by source for any other span come from member records (sources).
- Daily activity counts likes + posts + comments + poll votes, in UTC days; the active-member series uses Skool's
  local day buckets, so do not line the two up day by day.
- Hobby plan: mrr_unit, members_cohorts and retention_cohorts are not offered — a plan limitation, not an error.
- Money: dollars throughout the output. firstPaidEstimate is computed (renewal date minus lifetime paid ÷ price).
- Nothing per-member comes back unless the members or paid view is asked for with summary:false. Emails and payment
  ids are never returned.
- A large community costs one request per 30 members for full counts; if Skool rate-limits or the server's
  per-call limit is reached, the result says partial:true with the reason. Ask for fewer views, or a narrower window.

ERRORS
- Results starting with [auth] = token or permission problem; [edge] = Skool's CDN blocked the request (not a token problem); [notfound] = bad id/slug; [ratelimit] = wait and retry; [http]/[parse] = Skool changed something — report it so the server can be fixed.
- Output is capped at 25k characters; lower limit or paginate if truncated.`;

function text(obj: unknown) {
  let s = JSON.stringify(obj, null, 1);
  if (s.length > MAX_CHARS) s = s.slice(0, MAX_CHARS) + `\n…[truncated at ${MAX_CHARS} chars — use a smaller limit or paginate]`;
  return { content: [{ type: "text" as const, text: s }] };
}

function fail(e: unknown) {
  const msg = e instanceof SkoolError ? `[${e.kind}] ${e.message}` : e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text" as const, text: msg }], isError: true };
}

const community = z.string().optional().describe("Community slug (the part after skool.com/). Defaults to the community configured on the server.");

/**
 * Every skool_search_gifs row is an https giphy.com URL, and that is all a stateless server can check: it cannot
 * know which URLs a session actually searched. Anything else would be registered with Skool as an arbitrary
 * external image, so it is refused here rather than left to the description alone.
 */
const giphyUrl = z.string().refine((u) => {
  try {
    const { protocol, hostname } = new URL(u);
    return protocol === "https:" && (hostname === "giphy.com" || hostname.endsWith(".giphy.com"));
  } catch { return false; }
}, "Must be an https giphy.com URL, taken from a skool_search_gifs result.");

/** One row from skool_search_gifs, handed straight back to attach that GIF. */
const gifPick = z.object({
  url: giphyUrl.describe("The `url` of the chosen skool_search_gifs result. Must be that exact URL — a hand-written or remembered Giphy link will not render."),
  thumbnailUrl: giphyUrl.optional().describe("The `thumbnailUrl` of the same result."),
  name: z.string().optional().describe("Short label for the file, e.g. the search term. Cosmetic; shows as the filename."),
}).optional().describe("A GIF to attach, taken from a skool_search_gifs result in THIS session. Omit for no GIF.");

/** Register the picked GIF with Skool and return the file ids for `attachments`; undefined when no GIF was picked. */
async function registerGif(c: SkoolClient, gif: z.infer<typeof gifPick>): Promise<string[] | undefined> {
  return gif ? [await c.createGifFile(gif.name || "gif", gif.url, gif.thumbnailUrl)] : undefined;
}

// ---------- classroom writes: shared pieces ----------

/**
 * Skool rejects a course, section or lesson title over 50 characters with HTTP 422 — and counts an emoji as ONE
 * (verified 2026-09-23: 51 × "T" refused, 26 × "🌱" accepted). zod's .max() counts UTF-16 units, which would wrongly
 * refuse emoji titles, so this counts code points.
 */
const itemTitle = z.string().trim().min(1).refine((s) => [...s].length <= 50, "Skool caps titles at 50 characters (an emoji counts as one).");
/** Skool's course form caps the plain-text description at 500 characters (its client's own limit). */
const COURSE_DESC_MAX = 500;
const courseSlugArg = z.string().describe("The course's URL segment from skool_list_courses, e.g. 'a6f22441'.");

type ItemKind = "course" | "section" | "lesson";
const kindOf = (unitType: string): ItemKind => (unitType === "set" ? "section" : unitType === "module" ? "lesson" : "course");

/** A course from the classroom index by slug. Works for an empty course, which the course page cannot be opened on. */
async function courseBySlug(c: SkoolClient, slug: string, courseSlug: string) {
  const course = (await c.classroom(slug)).find((x) => x.name === courseSlug);
  if (!course) throw new SkoolError(`No course "${courseSlug}" in ${slug}. Take the slug from skool_list_courses.`, "notfound", 404);
  return course;
}

/**
 * One course, section or lesson, plus every unit above it (course first). The course page can only be opened on a
 * LESSON — md = a section's or the course's own id is HTTP 400 (verified 2026-09-23) — so the id is tried as a lesson
 * first, which is also the only way to get a lesson's body, and anything else is found in the default page's tree.
 */
async function readItem(c: SkoolClient, slug: string, courseSlug: string, itemId: string) {
  let page;
  try { page = await c.coursePage(slug, courseSlug, itemId); } catch (e) {
    if (!(e instanceof SkoolError && (e.status === 400 || e.status === 404))) throw e;
    page = await c.coursePage(slug, courseSlug);
  }
  const root = page.course.course ?? page.course;
  if (root.id === itemId) return { unit: root, ancestors: [] as any[] };
  const path = SkoolClient.findPath(page.course, itemId);
  if (!path) throw new SkoolError(`${itemId} is not in course "${courseSlug}". Take ids from skool_get_course.`, "notfound", 404);
  return { unit: path[path.length - 1], ancestors: [root, ...path.slice(0, -1)] };
}

/**
 * A YouTube link -> the three fields Skool stores for a linked video, found the way its editor finds them: clean the
 * link, look it up with /video-meta (length, and proof the video exists), then take the largest thumbnail YouTube has.
 * Throws before anything is written when the link is not a findable YouTube video.
 */
async function youtubeFields(c: SkoolClient, raw: string) {
  const yt = N.youtubeLink(raw);
  if (!yt) throw new SkoolError(`"${raw}" is not a YouTube link. Only YouTube videos can be attached with these tools.`, "http");
  let meta;
  try { meta = await c.videoMeta(yt.url); } catch (e) {
    if (e instanceof SkoolError && e.status === 400) throw new SkoolError(`Skool could not find a YouTube video at ${yt.url}. Check the link.`, "notfound", 404);
    throw e;
  }
  const thumbnail = await SkoolClient.youtubeThumbnail(yt.videoId, meta.thumbnail ?? "");
  return {
    fields: { video_link: yt.url, video_len_ms: Number(meta.len_ms ?? 0), video_thumbnail: thumbnail },
    summary: { url: yt.url, youtubeTitle: meta.title ?? null, durationMinutes: meta.len_ms ? Math.round(Number(meta.len_ms) / 60000) : null },
  };
}

const itemUrl = (slug: string, courseSlug: string, kind: ItemKind, id: string) =>
  `https://www.skool.com/${slug}/classroom/${courseSlug}${kind === "lesson" ? `?md=${id}` : ""}`;

export function buildServer(env: Env): McpServer {
  const server = new McpServer(
    { name: "skool-mcp", version: "0.1.0" },
    {
      jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  // The accounts come from SKOOL_PROFILES (src/env.ts), so the enum and its description are built per server.
  const profiles = profilesOf(env);
  const names = profiles.map((p) => p.name) as [string, ...string[]];
  const roster = profiles.map((p) => `"${p.name}"${p.description ? ` = ${p.description}` : ""}`).join(", ");
  const profileRead = z.enum(names).default(names[0]).describe(`Which Skool account to act as: ${roster}. Defaults to "${names[0]}".`);
  const profileWrite = z.enum(names).describe(`Which Skool account posts this. REQUIRED for writes: ${roster}. Ask the user if unsure.`);

  const client = (profile: Profile) => new SkoolClient(tokenFor(profile, env), profile);
  const slugOf = (c?: string) => c || env.SKOOL_DEFAULT_SLUG;
  /** How to get the rest of a comment thread, spelled out so a partial read is never mistaken for a whole one. */
  const continueHint = (postId: string, slug: string, cursor: string, total: number | null | undefined) =>
    `Partial thread${total ? ` (the post has ${total} comments in all)` : ""}. Call skool_get_comments with postId "${postId}"` +
    `${slug === env.SKOOL_DEFAULT_SLUG ? "" : ` and community "${slug}"`}, cursor "${cursor}" for the next page, and repeat until hasMore is false.`;
  const groupIdCache = new Map<string, string>([[env.SKOOL_DEFAULT_SLUG, env.SKOOL_DEFAULT_GROUP_ID]]);
  async function groupId(c: SkoolClient, slug: string): Promise<string> {
    const hit = groupIdCache.get(slug);
    if (hit) return hit;
    const g = await c.groupBySlug(slug);
    if (!g?.id) throw new SkoolError(`Could not resolve a group id for "${slug}".`, "notfound", 404);
    groupIdCache.set(slug, g.id);
    return g.id;
  }

  // ---------- guide / identity / community ----------

  server.registerTool("skool_usage_guide", {
    description: "The full reference, kept out of the always-loaded instructions. Read it before courses, transcripts, old-post search, communities the account has not joined, or polls — each has a mechanic that cannot be guessed — and whenever a result looks empty or wrong. Covers profiles, reading, the write rules, @mentions, classroom, discovery, polls and errors.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true },
  }, async () => ({ content: [{ type: "text" as const, text: USAGE_GUIDE }] }));

  server.registerTool("skool_whoami", {
    description: "Check that a profile's Skool session works. Returns the account's communities. Run this first when something fails.",
    inputSchema: z.object({ profile: profileRead }),
    annotations: { readOnlyHint: true },
  }, async ({ profile }) => {
    try {
      const c = client(profile);
      const groups = await c.myGroups();
      return text({ profile, communities: groups.map((g) => ({ slug: g.name, id: g.id })) });
    } catch (e) { return fail(e); }
  });

  server.registerTool("skool_community", {
    description: "Everything about one community, joined or not. Always returns the About page: description, member/post counts, price, rating, the questions asked of applicants, the owner, and publicFeed (true = its feed is readable without joining). For a community the profile belongs to it also returns the category labels — the labelId a post needs — plus rules and the level ladder. Those three are simply absent when the profile is not a member or not an admin; that is not an error. Defaults to the community configured on the server; pass any slug (from skool_discover_communities) to inspect another.",
    inputSchema: z.object({
      profile: profileRead,
      community: z.string().optional().describe("Slug — the part after skool.com/, e.g. 'earth2'. NOT the display name. Defaults to the community configured on the server."),
      includeReviews: z.boolean().default(false).describe("Add what members wrote in their reviews."),
      reviewLimit: z.number().int().min(1).max(30).default(5),
    }),
    annotations: { readOnlyHint: true },
  }, async ({ profile, community: com, includeReviews, reviewLimit }) => {
    try {
      const c = client(profile); const slug = slugOf(com);
      const g = await c.groupBySlug(slug);
      const out: any = N.groupAbout(g);
      // Member/admin-only extras. Each is attempted independently so one [auth] does not hide the others:
      // labels needs admin, rules and levels only membership.
      const opt = async (key: string, fn: () => Promise<any>) => { try { out[key] = await fn(); } catch { /* not a member/admin */ } };
      await Promise.all([
        opt("labels", async () => (await c.labels(g.id)).map(N.label)),
        opt("rules", async () => (await c.rules(g.id)).map(N.rule)),
        opt("levels", async () => (await c.levels(g.id)).map(N.groupLevel)),
      ]);
      if (includeReviews && g.id) out.reviews = (await c.reviews(g.id, reviewLimit)).map(N.review);
      return text(out);
    } catch (e) { return fail(e); }
  });

  // ---------- posts ----------

  server.registerTool("skool_list_posts", {
    description: "List posts in the community feed (about 30 per page). sort: newest-cm = most recent activity (default), newest = most recently created. labelId filters to one category.",
    inputSchema: z.object({
      profile: profileRead, community,
      page: z.number().int().min(1).default(1),
      sort: z.enum(["newest-cm", "newest"]).default("newest-cm"),
      labelId: z.string().optional(),
      limit: z.number().int().min(1).max(50).default(20).describe("Max posts to return from this page"),
      contentChars: z.number().int().min(0).max(5000).default(400).describe("Truncate each post's content to this many characters (0 = titles only)"),
    }),
    annotations: { readOnlyHint: true },
  }, async ({ profile, community: com, page, sort, labelId, limit, contentChars }) => {
    try {
      const c = client(profile); const slug = slugOf(com);
      const pp = await c.feed(slug, { page, sort, label: labelId });
      const seen = new Set<string>();
      const posts = [];
      for (const node of pp.postTrees ?? []) {
        const p = N.post(node, slug);
        if (seen.has(p.id)) continue; // pinned posts appear twice
        seen.add(p.id);
        if (p.content.length > contentChars) p.content = p.content.slice(0, contentChars) + "…";
        posts.push(p);
        if (posts.length >= limit) break;
      }
      return text({ community: slug, page, sort, totalPosts: pp.total, posts });
    } catch (e) { return fail(e); }
  });

  server.registerTool("skool_get_post", {
    description: "Read one post in full with the FIRST PAGE of its comment thread. Identify it by postSlug (URL name) or postId. A long thread is partial: `commentsPage` says hasMore and which skool_get_comments call fetches the rest; the pinned thread comes separately as `pinnedComments`.",
    inputSchema: z.object({
      profile: profileRead, community,
      postSlug: z.string().optional(), postId: z.string().optional(),
      withComments: z.boolean().default(true),
    }),
    annotations: { readOnlyHint: true },
  }, async ({ profile, community: com, postSlug, postId, withComments }) => {
    try {
      const c = client(profile); const slug = slugOf(com);
      let p;
      if (postSlug) p = N.post(await c.postPage(slug, postSlug), slug);
      else if (postId) {
        // api2 resolves any post id directly regardless of age, but returns user_id without the user
        // record; the post page has the full author, so resolve id -> slug -> page. Two requests, and
        // unlike the old feed scan it works for posts of any age.
        const raw = await c.postById(postId, await groupId(c, slug));
        if (!raw?.name) throw new SkoolError(`No post found for id ${postId} in ${slug}.`, "notfound", 404);
        p = N.post(await c.postPage(slug, raw.name), slug);
      } else throw new Error("Provide postSlug or postId.");
      const out: any = { ...p };
      if (withComments) {
        // The thread is paged. Spend whatever the post body left of the output cap so the response is never
        // sliced mid-JSON, and say how to continue when the thread is longer than that.
        const room = Math.max(MAX_CHARS - JSON.stringify(out, null, 1).length - COMMENTS_ENVELOPE, MIN_COMMENTS_BUDGET);
        const page = await readCommentsPage(c, await groupId(c, slug), p.id, { limit: DEFAULT_THREADS_PER_PAGE, attachmentUrls: false, budget: room });
        out.comments = page.comments;
        if (page.pinned.length) out.pinnedComments = page.pinned;
        out.commentsPage = pageFields(page, (cur) => continueHint(p.id, slug, cur, p.commentCount));
      }
      return text(out);
    } catch (e) { return fail(e); }
  });

  server.registerTool("skool_get_comments", {
    description: "Comments on a post by postId, nested replies included, one page at a time. A page is up to `limit` top-level threads (default 10, max 30), oldest first or `order: \"newest\"`. The result says totalComments, hasMore and a nextCursor: pass that back as `cursor` to continue until hasMore is false. The post's pinned thread comes separately, as `pinned`, on the first page only. Attachments come as type + fileName; set attachmentUrls for the full records.",
    inputSchema: z.object({
      profile: profileRead, community, postId: z.string(),
      limit: z.number().int().min(1).max(MAX_THREADS_PER_PAGE).default(DEFAULT_THREADS_PER_PAGE).describe("Top-level threads per page, 1-30. A page can come back with fewer when it would not fit the output cap; nextCursor still continues correctly."),
      order: z.enum(["oldest", "newest"]).optional().describe("Which end to start from. Oldest first is the default. Only for the first page: a cursor already carries its direction."),
      cursor: z.string().optional().describe("The nextCursor from the previous page, exactly as returned (e.g. after:1778694085437557). Omit for the first page."),
      attachmentUrls: z.boolean().default(false).describe("Return each attachment's full record with its (very long) GIF url. Default is type + fileName, which is enough to say what a GIF-only comment was."),
    }),
    annotations: { readOnlyHint: true },
  }, async ({ profile, community: com, postId, limit, order, cursor, attachmentUrls }) => {
    try {
      const c = client(profile); const slug = slugOf(com); const gid = await groupId(c, slug);
      // The comments call does not say how many comments the post has; the post record does. Best effort:
      // a failure here must not cost the page we already have.
      const [page, total] = await Promise.all([
        readCommentsPage(c, gid, postId, { limit, order, cursor, attachmentUrls, budget: MAX_CHARS - COMMENTS_ENVELOPE }),
        c.postById(postId, gid).then(commentTotal, () => null),
      ]);
      const out: any = { postId, totalComments: total, ...pageFields(page, (cur) => continueHint(postId, slug, cur, total)) };
      if (page.pinned.length) out.pinned = page.pinned;
      out.comments = page.comments;
      return text(out);
    } catch (e) { return fail(e); }
  });

  server.registerTool("skool_create_post", {
    description: "PUBLISH a post to the feed as `profile`. Notifies followers, and deleting does NOT retract that — confirm the text and the account first. labelId is required in communities that enforce categories; get it from skool_community. @mention as [@Full Name](obj://user/<userId>) — the ID does the tagging, so take it from a lookup this session, never from memory. Attach a GIF by passing a skool_search_gifs row as `gif`.",
    inputSchema: z.object({ profile: profileWrite, community, title: z.string().min(1), content: z.string().min(1), labelId: z.string().optional().describe("Category id from skool_community. Required in communities that enforce categories (many do)."), gif: gifPick }),
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, async ({ profile, community: com, title, content, labelId, gif }) => {
    try {
      const c = client(profile); const slug = slugOf(com);
      const attachments = await registerGif(c, gif);
      const r = await c.createPost(await groupId(c, slug), { title, content, labelId, attachments });
      return text({ created: true, profile, id: r.id, slug: r.name, gif: gif ? gif.url : null, url: r.name ? `https://www.skool.com/${slug}/${r.name}` : null });
    } catch (e) { return fail(e); }
  });

  server.registerTool("skool_create_poll", {
    description: "PUBLISH a post with a poll attached, as `profile`. Give the question as the post title/body and 2 or more options. Confirm the wording, the options and the profile with the user first — this posts publicly and notifies followers. Attach a GIF by passing a skool_search_gifs row as `gif`; it can only be attached now, since skool_edit_post cannot add one afterwards. Poll results are read back through skool_get_post / skool_list_posts, which return a `poll` field with each option's vote count and who voted.",
    inputSchema: z.object({
      profile: profileWrite, community,
      title: z.string().min(1).describe("The poll question, as the post title."),
      content: z.string().default("").describe("Optional body text under the question."),
      options: z.array(z.string().min(1)).min(2).max(10).describe("The poll options, in the order they should appear."),
      labelId: z.string().optional().describe("Category id from skool_community. Required in communities that enforce categories (many do)."),
      gif: gifPick,
    }),
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, async ({ profile, community: com, title, content, options, labelId, gif }) => {
    try {
      const c = client(profile); const slug = slugOf(com);
      const gid = await groupId(c, slug);
      // Two steps by design: the poll object exists first, then the post that references it.
      const created = await c.createPoll(gid, options);
      // POST /polls returns { poll_id }, not .id or .poll.id — confirmed 2026-09-08 by
      // capturing Skool's own web client request/response.
      const pollId = created.poll_id ?? created.id ?? created.poll?.id;
      if (!pollId) throw new SkoolError("Skool did not return a poll id; the post was NOT created.", "http");
      // The GIF file is registered last, right before the post that references it — same order as skool_create_post,
      // since Skool deletes a file no post references.
      let attachments: string[] | undefined;
      try {
        attachments = await registerGif(c, gif);
      } catch (e) {
        // No post exists yet, so the poll is an unreferenced orphan and safe to remove. Best effort: never mask the
        // real error. Deliberately NOT done if createPost fails below — that failure is ambiguous (the post may
        // have landed with the response lost), and deleting the poll then could destroy a live one.
        await c.deletePoll(pollId).catch(() => {});
        throw e;
      }
      const r = await c.createPost(gid, { title, content, labelId, pollId, attachments });
      return text({ created: true, profile, pollId, id: r.id, slug: r.name, gif: gif ? gif.url : null, url: r.name ? `https://www.skool.com/${slug}/${r.name}` : null, options });
    } catch (e) { return fail(e); }
  });

  server.registerTool("skool_create_comment", {
    description: "PUBLISH a comment as `profile`, or a threaded reply via parentCommentId. Notifies, and deleting does NOT retract that — confirm the text and the account first. @mention as [@Full Name](obj://user/<userId>) — the ID does the tagging, so take it from a lookup this session, never from memory. Attach a GIF by passing a skool_search_gifs row as `gif`; text is optional, since a GIF-only reply is normal here.",
    inputSchema: z.object({ profile: profileWrite, community, postId: z.string(), content: z.string().default("").describe("The comment text. May be empty when a gif is attached — a GIF-only reply is normal on Skool."), parentCommentId: z.string().optional(), gif: gifPick }),
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, async ({ profile, community: com, postId, content, parentCommentId, gif }) => {
    try {
      if (!content && !gif) throw new Error("A comment needs content, a gif, or both.");
      const c = client(profile); const slug = slugOf(com);
      const attachments = await registerGif(c, gif);
      const r = await c.createComment(await groupId(c, slug), postId, content, parentCommentId, attachments);
      return text({ created: true, profile, id: r.id, postId, gif: gif ? gif.url : null });
    } catch (e) { return fail(e); }
  });

  server.registerTool("skool_edit_post", {
    description: "Edit a published post OR comment that `profile` owns. Pass only what should change: omitting title leaves the title alone, so a content-only edit cannot blank the title. Unlike posting, editing sends NO notification — it silently rewrites what members already saw, so confirm the new wording with the user first. Returns the previous title and content so the change is visible and can be put back. Editing someone else's post fails with [auth]; a comment has no title, so pass content only.",
    inputSchema: z.object({
      profile: profileWrite, community,
      postId: z.string().describe("Id of the post or comment to edit."),
      title: z.string().optional().describe("New title. Omit to leave unchanged. Comments have no title."),
      content: z.string().optional().describe("New body text. Omit to leave unchanged."),
    }),
    annotations: { readOnlyHint: false, destructiveHint: true },
  }, async ({ profile, community: com, postId, title, content }) => {
    try {
      if (title === undefined && content === undefined) throw new Error("Nothing to edit: pass title, content, or both.");
      const c = client(profile); const slug = slugOf(com);
      const raw = await c.postById(postId, await groupId(c, slug));
      const before = (raw.post ?? raw)?.metadata ?? {};
      await c.updatePost(postId, { title, content });
      return text({
        edited: true, profile, postId,
        changed: [title !== undefined ? "title" : null, content !== undefined ? "content" : null].filter(Boolean),
        previousTitle: before.title ?? "",
        previousContent: before.content ?? "",
        note: "No notification was sent. The previous values are returned so the edit can be reverted.",
      });
    } catch (e) { return fail(e); }
  });

  server.registerTool("skool_delete_post", {
    description: "Delete a post or comment that `profile` owns (e.g. cleaning up a test post). Irreversible: confirm with the user.",
    inputSchema: z.object({ profile: profileWrite, postId: z.string() }),
    annotations: { destructiveHint: true },
  }, async ({ profile, postId }) => {
    try { return text({ deleted: true, postId, result: await client(profile).deletePost(postId) }); } catch (e) { return fail(e); }
  });

  // ---------- likes ----------

  server.registerTool("skool_like", {
    description: "Like or unlike a post OR a comment as `profile` — pass either one's id, they work the same way. Reads the current state first, so liking something already liked is reported as a no-op instead of silently toggling it off. A like notifies the author and cannot be un-notified by unliking, so confirm with the user which account is liking and what. Never bulk-like a feed: Skool rate-limits it (429) and it reads as botting to members.",
    inputSchema: z.object({
      profile: profileWrite, community,
      postId: z.string().describe("Id of the post or comment. Comment ids come from skool_get_comments / skool_get_post."),
      action: z.enum(["like", "unlike"]).default("like"),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ profile, community: com, postId, action }) => {
    try {
      const c = client(profile); const slug = slugOf(com);
      const gid = await groupId(c, slug);
      const before = await c.voteState(postId, gid);
      const want = action === "like" ? "up" : "";
      if (before.myVote === want) {
        return text({ changed: false, profile, postId, action, upvotes: before.upvotes, note: `Already ${action === "like" ? "liked" : "not liked"} by "${profile}" — nothing sent.` });
      }
      await c.votePost(postId, before.myVote, want as "up" | "");
      const after = await c.voteState(postId, gid);
      return text({ changed: true, profile, postId, action, likedByMe: after.myVote === "up", upvotes: after.upvotes, wasUpvotes: before.upvotes });
    } catch (e) { return fail(e); }
  });

  server.registerTool("skool_post_likers", {
    description: "Which members liked a post or comment. Useful for spotting who is quietly engaged — people who like often but rarely comment do not show up in a thread read or on the leaderboard. Returns the true total alongside the page, so a post with more likers than fit in one call still reports the real count.",
    inputSchema: z.object({
      profile: profileRead, postId: z.string(),
      limit: z.number().int().min(1).max(30).default(30),
      cursor: z.string().optional().describe("From a previous call's `cursor`, to fetch the next page when hasMore is true."),
    }),
    annotations: { readOnlyHint: true },
  }, async ({ profile, postId, limit, cursor }) => {
    try {
      const r = await client(profile).voteUsers(postId, limit, cursor);
      return text({ postId, count: r.users.length, total: r.total, hasMore: r.hasMore, cursor: r.cursor, likers: r.users.map((u) => N.author(u)) });
    } catch (e) { return fail(e); }
  });

  server.registerTool("skool_search_gifs", {
    description: "Search GIFs to attach to a post or comment, exactly as Skool's own GIF picker does (it calls Giphy directly). Returns candidates with a title so you can CHOOSE one that fits, rather than taking the first hit — then pass that whole result row as the `gif` argument of skool_create_post, skool_create_poll or skool_create_comment. Read-only and public: searching posts nothing. Pass the chosen row through unchanged; a Giphy URL written from memory will not render.",
    inputSchema: z.object({
      query: z.string().min(1).describe("What the GIF should show, e.g. \"welcome\", \"celebration\", \"thinking\"."),
      limit: z.number().int().min(1).max(24).default(12),
      offset: z.number().int().min(0).default(0).describe("Skip this many results — use it to see different options for the same query."),
    }),
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ query, limit, offset }) => {
    try {
      const results = (await SkoolClient.searchGifs(query, limit, offset, env.GIPHY_KEY)).map(N.gif).filter((g) => g.url);
      return text({ query, count: results.length, results });
    } catch (e) { return fail(e); }
  });

  // ---------- members ----------

  server.registerTool("skool_list_members", {
    description: "Members directory, 30 per page. includeEmail only when the user explicitly needs emails. includeAnswers adds each member's join-application answers (the questions they answered when requesting to join).",
    inputSchema: z.object({ profile: profileRead, community, page: z.number().int().min(1).default(1), includeEmail: z.boolean().default(false), includeAnswers: z.boolean().default(false) }),
    annotations: { readOnlyHint: true },
  }, async ({ profile, community: com, page, includeEmail, includeAnswers }) => {
    try {
      const c = client(profile); const slug = slugOf(com);
      const pp = await c.members(slug, page);
      return text({ community: slug, page, totalPages: pp.totalPages, totalMembers: pp.totalMembers, online: pp.totalOnlineMembers, members: (pp.users ?? []).map((u: any) => N.member(u, includeEmail, includeAnswers)) });
    } catch (e) { return fail(e); }
  });

  server.registerTool("skool_pending_members", {
    description: "Pending join requests with the applicant's application answers (admin only). Use the returned membershipId with skool_approve_member. There is no decline tool by design — declining is done by the user in Skool.",
    inputSchema: z.object({ profile: profileRead, community, page: z.number().int().min(1).default(1) }),
    annotations: { readOnlyHint: true },
  }, async ({ profile, community: com, page }) => {
    try {
      const c = client(profile); const slug = slugOf(com);
      const pp = await c.pendingMembers(slug, page);
      const users = (pp.users ?? []).filter((u: any) => u.member?.role === "pending");
      return text({ community: slug, page, count: users.length, requests: users.map(N.pendingRequest) });
    } catch (e) { return fail(e); }
  });

  server.registerTool("skool_approve_member", {
    description: "APPROVE a pending join request (admin). membershipId comes from skool_pending_members (not the userId). Confirm with the user first.",
    inputSchema: z.object({ profile: profileWrite, membershipId: z.string() }),
  }, async ({ profile, membershipId }) => {
    try { return text({ approved: true, membershipId, result: await client(profile).setMemberRole(membershipId, "member") }); } catch (e) { return fail(e); }
  });

  server.registerTool("skool_search_members", {
    description: "Find members by name.",
    inputSchema: z.object({ profile: profileRead, community, query: z.string().min(1), limit: z.number().int().min(1).max(50).default(10) }),
    annotations: { readOnlyHint: true },
  }, async ({ profile, community: com, query, limit }) => {
    try {
      const c = client(profile); const slug = slugOf(com);
      const users = await c.searchMembers(await groupId(c, slug), query, limit);
      return text({ query, results: users.map((u) => N.member(u, false)) });
    } catch (e) { return fail(e); }
  });

  // ---------- calendar ----------

  server.registerTool("skool_calendar", {
    description: "Community calendar events (upcoming by default; includePast for all).",
    inputSchema: z.object({ profile: profileRead, community, includePast: z.boolean().default(false), limit: z.number().int().min(1).max(50).default(20) }),
    annotations: { readOnlyHint: true },
  }, async ({ profile, community: com, includePast, limit }) => {
    try {
      const c = client(profile); const slug = slugOf(com);
      const pp = await c.calendar(slug);
      let events = (pp.events ?? []).map((e: any) => N.event(e, slug)).sort((a: any, b: any) => Date.parse(a.start) - Date.parse(b.start));
      if (!includePast) events = events.filter((e: any) => Date.parse(e.start) >= Date.now() - 3600_000);
      return text({ community: slug, timezone: pp.timezone ?? null, count: events.length, events: events.slice(0, limit) });
    } catch (e) { return fail(e); }
  });

  // ---------- direct messages ----------

  server.registerTool("skool_list_conversations", {
    description: "The profile's DM inbox. Each conversation names the member it is `with`, plus unread count, the last message, whether this account started the thread, and how many communities the two share. Use it to find the channelId for an existing thread, or to see who a profile is already talking to.",
    inputSchema: z.object({ profile: profileRead, limit: z.number().int().min(1).max(50).default(20), unreadOnly: z.boolean().default(false) }),
    annotations: { readOnlyHint: true },
  }, async ({ profile, limit, unreadOnly }) => {
    try { const chans = await client(profile).conversations(limit, unreadOnly); return text({ profile, count: chans.length, conversations: chans.map(N.conversation) }); } catch (e) { return fail(e); }
  });

  server.registerTool("skool_get_conversation", {
    description: "Messages in one DM conversation (most recent `limit`).",
    inputSchema: z.object({ profile: profileRead, channelId: z.string(), limit: z.number().int().min(1).max(100).default(30) }),
    annotations: { readOnlyHint: true },
  }, async ({ profile, channelId, limit }) => {
    try { const msgs = await client(profile).messages(channelId, limit); return text({ channelId, messages: msgs.slice(-limit).map(N.message) }); } catch (e) { return fail(e); }
  });

  server.registerTool("skool_send_message", {
    description: "SEND a DM as `profile`, to a channelId or straight to a userId (opening the conversation if there is none, reusing the existing one if there is). A DM CANNOT BE DELETED by anyone, including the recipient — there is no cleaning one up, so confirm the wording and the account with the user first. Attach a GIF by passing a skool_search_gifs row as `gif`; text is optional when one is attached.",
    inputSchema: z.object({
      profile: profileWrite, community,
      channelId: z.string().optional().describe("Existing conversation, from skool_list_conversations."),
      userId: z.string().optional().describe("Member to message, from skool_search_members. Used when channelId is not given."),
      content: z.string().default("").describe("The message text. May be empty when a gif is attached."),
      gif: gifPick,
    }),
  }, async ({ profile, community: com, channelId, userId, content, gif }) => {
    try {
      if (!content && !gif) throw new Error("A message needs content, a gif, or both.");
      if (!channelId && !userId) throw new Error("Provide channelId (existing conversation) or userId (the member to message).");
      const c = client(profile);
      let chan = channelId;
      let openedNew = false;
      if (!chan) {
        // Skool hands back the existing channel when one already exists, so this cannot split a history.
        const r = await c.startChat(await groupId(c, slugOf(com)), userId!);
        chan = (r.channel ?? r)?.id;
        openedNew = r.created === true;
        if (!chan) throw new SkoolError("Skool did not return a channel id; nothing was sent.", "http");
      }
      // DMs take an ARRAY of file ids; posts and comments take the same ids comma-joined. See sendMessage.
      const attachments = (await registerGif(c, gif)) ?? [];
      const r = await c.sendMessage(chan, content, attachments);
      return text({ sent: true, profile, channelId: chan, openedNewConversation: openedNew, id: r.id ?? null, gif: gif ? gif.url : null });
    } catch (e) { return fail(e); }
  });

  server.registerTool("skool_mark_read", {
    description: "Mark a DM conversation read for `profile`. One-way: these tools cannot mark it unread again.",
    inputSchema: z.object({ profile: profileWrite, channelId: z.string() }),
  }, async ({ profile, channelId }) => {
    try {
      const r = await client(profile).markRead(channelId);
      return text({ profile, channelId, unread: Number(r.num_unread ?? 0), lastReadMessageId: r.last_read ?? null });
    } catch (e) { return fail(e); }
  });

  // ---------- classroom / courses ----------

  server.registerTool("skool_list_courses", {
    description: "List the courses in a community's classroom. Returns each course's slug (the URL segment you pass to the other course tools — NOT the title), title, description, module count, and whether this profile has access. Start here for anything about course or lesson content.",
    inputSchema: z.object({ profile: profileRead, community }),
    annotations: { readOnlyHint: true },
  }, async ({ profile, community: com }) => {
    try {
      const slug = slugOf(com);
      const courses = (await client(profile).classroom(slug)).map(N.courseSummary);
      return text({ community: slug, count: courses.length, courses });
    } catch (e) { return fail(e); }
  });

  server.registerTool("skool_get_course", {
    description: "The section-and-lesson outline of one course, by course slug. Returns the nested tree with each lesson's id, title, whether it has a video (videoKind: uploaded, youtube, or linked (provider)), and whether THIS profile has completed it (completedByProfile), plus the profile's completed-lesson count. That is the reading profile's own progress; every member's lessons-completed count per course is in skool_analytics (view courses, admin). IMPORTANT: lesson bodies are NOT in this outline — Skool only returns a lesson's text when that lesson is the selected module, so use skool_get_lesson (one call per lesson) to read content.",
    inputSchema: z.object({ profile: profileRead, community, courseSlug: z.string().describe("The course's URL segment from skool_list_courses, e.g. 'a6f22441'.") }),
    annotations: { readOnlyHint: true },
  }, async ({ profile, community: com, courseSlug }) => {
    try {
      const slug = slugOf(com);
      const { course, moduleId } = await client(profile).coursePage(slug, courseSlug);
      const root = course.course ?? course;
      return text({
        community: slug, courseSlug,
        ...N.courseSummary(root),
        // metadata.userCompleted is a COUNT of lessons this profile finished (e.g. 5 of 9), absent at 0.
        progress: {
          profile,
          lessonsCompleted: Number(root.metadata?.userCompleted ?? 0),
          lessonsInCourse: root.metadata?.numModules ?? null,
          note: `"${profile}"'s own progress. Every member's count per course: skool_analytics, view "courses" (admin).`,
        },
        firstLessonId: moduleId ?? null,
        outline: N.courseTree(course),
      });
    } catch (e) { return fail(e); }
  });

  server.registerTool("skool_get_lesson", {
    description: "Read ONE lesson in full: its written body (Skool stores this as ProseMirror JSON; it is rendered to markdown here), attached resources, and video details. Pass lessonId from skool_get_course; omit it to get the course's first lesson. If the lesson has a video and you need the spoken content, follow up with skool_get_transcript.",
    inputSchema: z.object({
      profile: profileRead, community,
      courseSlug: z.string(),
      lessonId: z.string().optional().describe("Module id from skool_get_course. Omitted = the course's first lesson."),
    }),
    annotations: { readOnlyHint: true },
  }, async ({ profile, community: com, courseSlug, lessonId }) => {
    try {
      const slug = slugOf(com);
      const { course, video, moduleId } = await client(profile).coursePage(slug, courseSlug, lessonId);
      if (!moduleId) throw new SkoolError(`Course "${courseSlug}" has no lessons yet.`, "notfound", 404);
      const mod = SkoolClient.findUnit(course, moduleId);
      if (!mod) throw new SkoolError(`Lesson ${moduleId} is not in course "${courseSlug}".`, "notfound", 404);
      return text(N.lesson(mod, video, courseSlug, slug));
    } catch (e) { return fail(e); }
  });

  server.registerTool("skool_create_course_item", {
    description: "Create a new course, section (folder) or lesson in the classroom as `profile`, which must be an admin of the community. Everything is created as a DRAFT that members cannot see; going live is a separate skool_set_published call. A lesson can be created with its body (markdown, same format as skool_edit_course_item) and a YouTube video in one go. New items go at the end of their course or section. Confirm the titles with the user first. Returns the new id, and for a course its courseSlug, which the other course tools take.",
    inputSchema: z.object({
      profile: profileWrite, community,
      type: z.enum(["course", "section", "lesson"]),
      title: itemTitle.describe("Max 50 characters; an emoji counts as one."),
      courseSlug: courseSlugArg.optional().describe("Required for a section or lesson: the course it goes in, from skool_list_courses."),
      sectionId: z.string().optional().describe("Lesson only: put it inside this section (id from skool_get_course). Omit to put the lesson directly in the course."),
      body: z.string().optional().describe(`Lesson: the body as markdown. Course: a short plain-text description, max ${COURSE_DESC_MAX} characters. Not used for a section.`),
      videoUrl: z.string().optional().describe("Lesson only: a YouTube link to show as the lesson's video."),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, async ({ profile, community: com, type, title, courseSlug, sectionId, body, videoUrl }) => {
    try {
      if (type !== "lesson" && (sectionId !== undefined || videoUrl !== undefined)) throw new Error("sectionId and videoUrl are for lessons only.");
      if (type === "section" && body !== undefined) throw new Error("A section has only a title; body is for a lesson, or a course's description.");
      if (type === "course" && body && [...body].length > COURSE_DESC_MAX) throw new Error(`A course description is capped at ${COURSE_DESC_MAX} characters.`);
      const c = client(profile); const slug = slugOf(com);
      const gid = await groupId(c, slug);

      if (type === "course") {
        // privacy 0 = "Open" (all members can access once published), what every course here uses. Level, time,
        // price and tier locks are Skool settings these tools do not expose.
        const r = await c.createCourseUnit(gid, { unitType: "course", title, metadata: { desc: body ?? "", privacy: 0, lock_free_trial: 0 } });
        return text({
          created: true, type, profile, id: r.id, courseSlug: r.name, state: "draft",
          url: `https://www.skool.com/${slug}/classroom/${r.name}`,
          note: "Draft: members cannot see it. Add sections and lessons with this courseSlug, then publish with skool_set_published.",
        });
      }

      if (!courseSlug) throw new Error(`A ${type} needs courseSlug: the course it goes in, from skool_list_courses.`);
      const course = await courseBySlug(c, slug, courseSlug);
      let parentId = course.id as string;
      if (sectionId) {
        const { unit } = await readItem(c, slug, courseSlug, sectionId);
        if (unit.unitType !== "set") throw new SkoolError(`${sectionId} is a ${kindOf(unit.unitType)}, not a section.`, "http");
        parentId = sectionId;
      }
      const metadata: Record<string, unknown> = {};
      let video: unknown = null;
      if (type === "lesson") {
        metadata.resources = "[]"; // what Skool's own editor sends for a new lesson
        if (body !== undefined) metadata.desc = N.markdownToRichText(body);
        if (videoUrl) {
          // Looked up BEFORE creating, so a bad link fails with nothing written.
          const v = await youtubeFields(c, videoUrl);
          Object.assign(metadata, v.fields);
          video = v.summary;
        }
      }
      const r = await c.createCourseUnit(gid, { unitType: type === "section" ? "set" : "module", title, rootId: course.id, parentId, metadata });
      return text({
        created: true, type, profile, id: r.id, courseSlug, parentId, state: "draft",
        ...(type === "lesson" ? { video } : {}),
        url: itemUrl(slug, courseSlug, type, r.id),
        note: "Draft: members cannot see it until it, and every section and course above it, is published (skool_set_published).",
      });
    } catch (e) { return fail(e); }
  });

  server.registerTool("skool_edit_course_item", {
    description: "Change an EXISTING course, section or lesson as `profile` (an admin). Pass only what should change; anything omitted is left exactly as it is. `title` works on all three. For a lesson, `body` (markdown) REPLACES the whole body and `videoUrl` sets or replaces its YouTube video (\"\" removes it). For a course, `body` is its short plain-text description. Never changes draft/published state and sends no notification, but on a published item members see the change at once. Returns the previous values so the edit can be put back. Confirm the final text with the user first. Ids come from skool_get_course; a course's own id from skool_list_courses.",
    inputSchema: z.object({
      profile: profileWrite, community,
      courseSlug: courseSlugArg,
      itemId: z.string().describe("Id of the lesson, the section, or the course itself."),
      title: itemTitle.optional().describe("New title. Max 50 characters; an emoji counts as one."),
      body: z.string().optional().describe(`Lesson: new body as markdown (#### headings, paragraphs, - bullets, 1. numbered, **bold**, *italic*, \`code\`, [text](url), --- rule; one newline = line break, blank line = new paragraph). Replaces the whole body. Course: new plain-text description, max ${COURSE_DESC_MAX} characters.`),
      videoUrl: z.string().optional().describe("Lesson only: a YouTube link to set or replace the lesson's video. \"\" removes the linked video."),
    }),
    annotations: { readOnlyHint: false, destructiveHint: true },
  }, async ({ profile, community: com, courseSlug, itemId, title, body, videoUrl }) => {
    try {
      if (title === undefined && body === undefined && videoUrl === undefined) throw new Error("Nothing to edit: pass title, body, videoUrl, or a combination.");
      const c = client(profile); const slug = slugOf(com);
      const { unit } = await readItem(c, slug, courseSlug, itemId);
      const kind = kindOf(unit.unitType);
      if (kind === "section" && body !== undefined) throw new Error("A section has only a title.");
      if (kind !== "lesson" && videoUrl !== undefined) throw new Error("videoUrl is for lessons only.");
      if (kind === "course" && body && [...body].length > COURSE_DESC_MAX) throw new Error(`A course description is capped at ${COURSE_DESC_MAX} characters.`);
      const m = unit.metadata ?? {};

      // PUT /courses/{id} is a verified partial (see SkoolClient.updateCourse): only the keys sent are written.
      const put: Record<string, unknown> = {};
      if (title !== undefined) put.title = title;
      if (body !== undefined) put.desc = kind === "lesson" ? N.markdownToRichText(body) : body;
      let video: unknown;
      if (videoUrl !== undefined) {
        // An uploaded video (videoId, hosted by Skool on Mux) is not a link. Overwriting it could lose the upload,
        // so it is left to Skool's own editor.
        if (m.videoId) throw new SkoolError("This lesson's video was uploaded to Skool, not linked. Replace or remove an uploaded video in Skool itself.", "http");
        if (videoUrl) {
          const v = await youtubeFields(c, videoUrl);
          Object.assign(put, v.fields);
          video = v.summary;
        } else {
          Object.assign(put, { video_link: "", video_thumbnail: "", video_len_ms: 0 }); // Skool's own "remove video"
          video = null;
        }
      }
      const saved = await c.updateCourse(itemId, put);
      const sm = saved.metadata ?? {};
      const bodyOf = (desc: unknown) => (kind === "lesson" ? N.richText(desc) : (desc ?? ""));
      return text({
        edited: true, profile, type: kind, id: itemId,
        changed: Object.entries({ title, body, videoUrl }).filter(([, v]) => v !== undefined).map(([k]) => k),
        state: (saved.state ?? unit.state) === 2 ? "published" : "draft",
        title: sm.title ?? m.title ?? "",
        ...(body !== undefined ? { body: bodyOf(sm.desc) } : {}),
        ...(videoUrl !== undefined ? { video } : {}),
        url: itemUrl(slug, courseSlug, kind, itemId),
        previous: {
          title: m.title ?? "",
          ...(body !== undefined ? { body: bodyOf(m.desc) } : {}),
          ...(videoUrl !== undefined ? { videoUrl: m.videoLink || null } : {}),
        },
        note: "No notification was sent. Draft/published state was not touched.",
      });
    } catch (e) { return fail(e); }
  });

  server.registerTool("skool_set_published", {
    description: "PUBLISH or UNPUBLISH a course, section or lesson as `profile` (an admin). This is outward-facing: publishing can put content in front of every member at once, and unpublishing hides content members may be partway through. Show the user exactly which item will change and get an explicit yes first. Members see an item only when it AND every section and course above it are published. Publishing one item never publishes its parent or its contents, so the result reports visibleToMembers and any parent still in draft. Skool's editor has no notify option for this and none was observed in testing, but that could only be tested on items members could not see.",
    inputSchema: z.object({
      profile: profileWrite, community,
      courseSlug: courseSlugArg,
      itemId: z.string().describe("Id of the lesson, the section, or the course itself (skool_get_course / skool_list_courses)."),
      published: z.boolean().describe("true = publish, false = back to draft."),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ profile, community: com, courseSlug, itemId, published }) => {
    try {
      const c = client(profile); const slug = slugOf(com);
      const before = await readItem(c, slug, courseSlug, itemId);
      const kind = kindOf(before.unit.unitType);
      const was = before.unit.state === 2;
      if (was !== published) await c.setCourseState(itemId, published);
      // Re-read rather than trust the empty 200: this is the one write whose effect members see directly.
      const now = was === published ? before : await readItem(c, slug, courseSlug, itemId);
      const isPublished = now.unit.state === 2;
      if (isPublished !== published) throw new SkoolError(`Skool accepted the request but the ${kind} still reads as ${isPublished ? "published" : "draft"}.`, "http");
      const draftAbove = now.ancestors.filter((a: any) => a.state !== 2).map((a: any) => ({ type: kindOf(a.unitType), id: a.id, title: a.metadata?.title ?? "" }));
      return text({
        changed: was !== published, profile, type: kind, id: itemId, title: now.unit.metadata?.title ?? "",
        published: isPublished,
        visibleToMembers: isPublished && draftAbove.length === 0,
        ...(isPublished && draftAbove.length ? { hiddenBy: draftAbove, note: "Published, but members still cannot see it: the item(s) in hiddenBy are drafts." } : {}),
        ...(was === published ? { note: `Already ${published ? "published" : "a draft"}; nothing sent.` } : {}),
        url: itemUrl(slug, courseSlug, kind, itemId),
      });
    } catch (e) { return fail(e); }
  });

  server.registerTool("skool_get_transcript", {
    description: "Spoken transcript of a lesson's video, as plain text. One call covers ~22 minutes; if the response sets nextStartSegment, call again with it until null and join in order. Captions are machine-generated — expect [Music] and mis-hearings, and say so before quoting them as someone's words. With a shell, the one-shot curl route in skool_usage_guide is far faster on long videos.",
    inputSchema: z.object({
      profile: profileRead, community,
      courseSlug: z.string(),
      lessonId: z.string().optional(),
      startSegment: z.number().int().min(0).default(0).describe("Resume point: pass nextStartSegment from the previous call. 0 = start of the video."),
    }),
    annotations: { readOnlyHint: true },
  }, async ({ profile, community: com, courseSlug, lessonId, startSegment }) => {
    try {
      const slug = slugOf(com);
      const c = client(profile);
      const { course, video, moduleId } = await c.coursePage(slug, courseSlug, lessonId);
      if (!moduleId) throw new SkoolError(`Course "${courseSlug}" has no lessons yet.`, "notfound", 404);
      const mod = SkoolClient.findUnit(course, moduleId);
      const title = mod?.metadata?.title ?? "";
      // Skool's own transcript field is normally empty, but when set it is the whole thing for free.
      if (mod?.metadata?.transcript) {
        return text({ lessonId: moduleId, title, source: "skool", nextStartSegment: null, transcript: mod.metadata.transcript });
      }
      if (!video?.playbackId) throw new SkoolError(`Lesson "${title || moduleId}" has no video to transcribe.`, "notfound", 404);
      const segments = await c.captionSegments(video.playbackId, video.playbackToken);
      if (!segments) return text({ lessonId: moduleId, title, source: "mux", nextStartSegment: null, transcript: "", note: "This video has no caption track — Skool had not auto-captioned it." });
      const window = segments.slice(startSegment, startSegment + MAX_CAPTION_SEGMENTS);
      const transcript = vttToText(await c.captionWindow(window));
      const next = startSegment + window.length;
      return text({
        lessonId: moduleId, title, source: "mux",
        durationMinutes: video.duration ? Math.round(video.duration / 60000) : null,
        // Everything a curl-capable client needs to pull the whole transcript in one pass, no paging.
        manifestUrl: `https://stream.mux.com/${video.playbackId}.m3u8?token=${video.playbackToken}`,
        totalSegments: segments.length,
        coveredSegments: `${startSegment}-${next - 1}`,
        approxMinutesCovered: Math.round((window.length * 30) / 60),
        nextStartSegment: next < segments.length ? next : null,
        transcript,
      });
    } catch (e) { return fail(e); }
  });

  // ---------- activity ----------

  server.registerTool("skool_notifications", {
    description: "This account's Skool notifications across ALL its communities: who did what, where, unread first-class, with the post id and link so you can go straight to the thread. The fastest way to answer 'what happened while I was away'.",
    inputSchema: z.object({
      profile: profileRead,
      // Skool rejects limit > 30 on this endpoint with HTTP 400 "invalid limit" (measured 2026-09-07).
      limit: z.number().int().min(1).max(30).default(20),
      unreadOnly: z.boolean().default(false),
    }),
    annotations: { readOnlyHint: true },
  }, async ({ profile, limit, unreadOnly }) => {
    try {
      const d = await client(profile).notifications(limit);
      let items = (d.messages ?? []).map((n: any) => N.notification(n));
      if (unreadOnly) items = items.filter((n: any) => n.unread);
      return text({ profile, count: items.length, unread: items.filter((n: any) => n.unread).length, hasMore: !!d.has_more, notifications: items });
    } catch (e) { return fail(e); }
  });

  server.registerTool("skool_search_posts", {
    description: "Search posts inside a community by keyword. This is the ONLY way to reach posts older than the recent feed — skool_list_posts walks the feed from the newest end only, so anything further back is unreachable without this.",
    inputSchema: z.object({
      profile: profileRead, community,
      query: z.string().min(1),
      page: z.number().int().min(1).default(1),
      limit: z.number().int().min(1).max(30).default(10),
      contentChars: z.number().int().min(0).max(5000).default(500),
    }),
    annotations: { readOnlyHint: true },
  }, async ({ profile, community: com, query, page, limit, contentChars }) => {
    try {
      const slug = slugOf(com);
      const pp = await client(profile).searchPosts(slug, query, page);
      const posts = (pp.postTrees ?? []).slice(0, limit).map((n: any) => {
        const p = N.post(n, slug);
        if (p.content.length > contentChars) p.content = p.content.slice(0, contentChars) + "…";
        return p;
      });
      return text({ community: slug, query, page, totalPosts: pp.totalPosts ?? null, totalPages: pp.totalPostPages ?? null, count: posts.length, posts });
    } catch (e) { return fail(e); }
  });

  server.registerTool("skool_leaderboard", {
    description: "Top contributors in a community for the last 7 days, last 30 days and all time, plus how members are spread across the community's levels. Useful for spotting who is actually active and who is going quiet.",
    inputSchema: z.object({ profile: profileRead, community, period: z.enum(["7d", "30d", "all", "everything"]).default("everything") }),
    annotations: { readOnlyHint: true },
  }, async ({ profile, community: com, period }) => {
    try {
      const slug = slugOf(com);
      const d = await client(profile).leaderboards(slug);
      const board = (b: any) => (b?.users ?? []).map((u: any, i: number) => N.leaderboardUser(u, i + 1));
      const out: any = { community: slug, levels: (d.groupLevels ?? []).map(N.groupLevel) };
      if (period === "7d" || period === "everything") out.past7Days = board(d.past7Days);
      if (period === "30d" || period === "everything") out.past30Days = board(d.past30Days);
      if (period === "all" || period === "everything") out.allTime = board(d.allTime);
      return text(out);
    } catch (e) { return fail(e); }
  });

  // ---------- analytics (admin only) ----------

  const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");
  server.registerTool("skool_analytics", {
    description: `Everything in Skool's admin analytics, in ONE call that returns only the \`views\` asked for (admin profile only; read-only). snapshot (default) = the weekly check-in record for a 7-day window ending yesterday. courses = every member's lessons completed per course (collected nightly; uploaded videos tick at 90%, YouTube/linked only on Done). overview = daily/weekly/monthly active members, daily activity, Dashboard and Growth headlines. charts = Skool's charts by name. sources = joins by source and referrer over ANY from–to dates (from member records). members = filtered member counts, or rows with summary:false. paid = paying members and monthly income. Every number is labelled with what it is, its window and the Skool screen. "Members" is three different counts on three screens — report which. Read skool_usage_guide → ANALYTICS before first use.`,
    inputSchema: z.object({
      profile: profileRead, community,
      views: z.array(z.enum(VIEWS)).min(1).default(["snapshot"]).describe("What to return. Only these are fetched."),
      charts: z.array(z.enum(CHARTS)).optional().describe(`charts view only. Default: ${DEFAULT_CHARTS.join(", ")}.`),
      from: isoDate.optional().describe("Window start (UTC day). snapshot: default 6 days before `to`. sources: default 29 days before `to`. paid: window for startedPaying. overview: daily-activity window."),
      to: isoDate.optional().describe("Window end, inclusive. snapshot default: yesterday. Others: today."),
      status: z.enum(STATUSES).default("active").describe("members view: which tab of the Members page."),
      tier: z.enum(["free", "paid"]).optional().describe("members view filter."),
      source: z.string().optional().describe("members view filter: a source (direct, skool, external, affiliate, invite) or a source detail (instagram.com, discovery_browse_group_link, …)."),
      joinedAfter: isoDate.optional().describe("members view filter, inclusive."),
      joinedBefore: isoDate.optional().describe("members view filter, inclusive."),
      minLevel: z.number().int().min(1).max(9).optional().describe("members view filter: Skool level at least this."),
      fields: z.array(z.enum(MEMBER_FIELDS)).optional().describe(`members view rows: which fields. Default: ${DEFAULT_FIELDS.join(", ")}.`),
      limit: z.number().int().min(1).max(MAX_ROWS).default(25).describe(`Rows per page (members / paid / courses with summary:false). Max ${MAX_ROWS}.`),
      page: z.number().int().min(1).default(1),
      summary: z.boolean().default(true).describe("members / paid / courses: true = counts only, no rows (works at any size). false = rows."),
      excludeHandles: z.array(z.string()).default([]).describe("Member handles (e.g. 'jane-doe-1234') left out of paying counts and income, and out of course-progress counts — e.g. the owner, team members or comped accounts. Handles not found are reported back."),
      includeNames: z.boolean().default(true).describe("snapshot: list names next to the joined / left / started-paying / cancelling counts. false = counts only."),
    }),
    annotations: { readOnlyHint: true },
  }, async ({ profile, community: com, ...args }) => {
    try {
      const c = client(profile); const slug = slugOf(com);
      return text(await runAnalytics(c, slug, await groupId(c, slug), args, () => latestProgress(env)));
    } catch (e) {
      if (e instanceof SkoolError && e.kind === "auth" && e.status === 401) {
        return fail(new SkoolError(`Skool's analytics are admin-only, and profile "${profile}" is not an admin of this community (HTTP 401). Use the community's admin profile (on this server the first configured one is "${names[0]}").`, "auth", 401));
      }
      return fail(e);
    }
  });

  // ---------- discovery: communities the account has NOT joined ----------

  server.registerTool("skool_discover_communities", {
    description: "Browse or search Skool's public directory of communities the account has NOT joined — the skool.com/discovery feed. Use it to find communities matching criteria (topic, price, size, language). Returns slug, name, tagline, member count, price, and publicFeed: when publicFeed is true you can read that community's posts and comments right away with skool_list_posts / skool_get_post / skool_get_comments by passing its slug as `community`, without joining. Follow up with skool_community for the full About page.",
    inputSchema: z.object({
      profile: profileRead,
      query: z.string().optional().describe("Free-text search over communities, e.g. 'meditation' or 'conscious relationships'."),
      category: z.enum(["hobbies", "music", "money", "spirituality", "tech", "health", "sports", "self_improvement", "relationships"]).optional(),
      price: z.enum(["free", "paid", "free-trial"]).optional(),
      type: z.enum(["private", "public"]).optional().describe("Skool's own privacy filter. 'public' communities are the ones whose feed a non-member can read."),
      sort: z.enum(["trending", "top"]).default("trending"),
      language: z.string().optional().describe("Lowercase language name, e.g. 'english', 'spanish'. Defaults to Skool's own default (english)."),
      page: z.number().int().min(1).default(1).describe("30 results per page; Skool caps any query at ~1000 results (~34 pages)."),
      limit: z.number().int().min(1).max(30).default(30),
    }),
    annotations: { readOnlyHint: true },
  }, async ({ profile, query, category, price, type, sort, language, page, limit }) => {
    try {
      const pp = await client(profile).discover({ q: query, category, price, type, sort, language, page });
      const groups = (pp.groups ?? []).slice(0, limit).map(N.discoveryGroup);
      return text({
        query: query ?? null, category: category ?? null, price: price ?? null, type: type ?? null, sort, page,
        matchedTotal: pp.numGroups ?? null,
        morePages: (pp.groups ?? []).length >= 30,
        count: groups.length,
        communities: groups,
      });
    } catch (e) { return fail(e); }
  });

  server.registerTool("skool_raw_get", {
    description: "LAST RESORT, for debugging only: inspecting a raw shape Skool changed, or a tool that broke. Every feature of this server has a dedicated tool — if you are about to guess a Skool URL, stop and use it (skool_usage_guide lists what exists). Authenticated GET on any skool.com URL; returns status + first 20k chars.",
    inputSchema: z.object({ profile: profileRead, url: z.string().url() }),
    annotations: { readOnlyHint: true },
  }, async ({ profile, url }) => {
    try { return text(await client(profile).rawGet(url)); } catch (e) { return fail(e); }
  });

  return server;
}
