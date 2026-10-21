# Technical notes

Everything learned about Skool's internal API while building and running this server: how each tool works, the
traps that cost real time to find, and how to keep it working when Skool changes. The setup guide is in
[README.md](README.md); your own record of what you have tested goes in [VERIFICATION.md](VERIFICATION.md).

Dates are when a behaviour was verified against live Skool. Skool changes without notice, so treat any of this as
"true when checked" — the daily health check is what tells you when something stops being true.

## Architecture

```
Claude (web / desktop / phone)
   │  POST https://skool-mcp.<subdomain>.workers.dev/mcp/<MCP_PATH_SECRET>/<MCP_ADMIN_KEY>   (MCP 2026-07-28, stateless)
   ▼
Cloudflare Worker  src/index.ts     gate 1: exact secret path   gate 2: MCP_ADMIN_KEY (URL or header)
   │                                gate 3: caller IP ∈ Anthropic egress 160.79.104.0/21 (all three required)
   ├─ src/tools.ts      MCP tools (zod schemas) → pick profile → SkoolClient
   ├─ src/analytics.ts  skool_analytics: views, member-record counting, subrequest budget
   ├─ src/skool.ts      all Skool endpoint literals + auth headers + error classification
   └─ src/normalize.ts  raw Skool shapes → small stable objects
        │
        ├─ www.skool.com/_next/data/{buildId}/…json   feed, members, calendar, post page  (buildId scraped, cached 30 min)
        └─ api2.skool.com                              comments, labels, search, DMs, ALL writes
```

No database, no Durable Objects, no session state. Every request is independent.

## Tool reference

Read (profile defaults to the first one in `SKOOL_PROFILES`):

| tool | what it does | main params |
|---|---|---|
| `skool_usage_guide` | The full reference: profiles, reading, writing rules, @mentions, classroom and transcripts, discovery, polls, errors. Deliberately not in the always-loaded instructions | none |
| `skool_whoami` | Check the session works; list the account's communities | `profile` |
| `skool_community` | Any community, joined or not: About page, price, rating, applicant questions — plus **category labels** (the `labelId` a post needs), rules and levels when the profile is a member/admin | `community?`, `includeReviews` |
| `skool_list_posts` | Feed page (~30/page); pinned posts de-duplicated | `page`, `sort` (`newest-cm`/`newest`), `labelId?`, `limit`, `contentChars` |
| `skool_get_post` | One post in full with the **first page** of its comment thread; `commentsPage` says if more remains and which call fetches it | `postSlug` or `postId`, `withComments` |
| `skool_get_comments` | A post's whole comment thread, one page at a time (cursor paging, oldest or newest first, pinned thread, `totalComments`) — see *Comment paging* | `postId`, `limit`, `order`, `cursor`, `attachmentUrls` |
| `skool_list_members` | Members directory, 30/page (`includeEmail` only on explicit request; `includeAnswers` adds join-application answers) | `page`, `includeEmail`, `includeAnswers` |
| `skool_search_members` | Find members by name | `query`, `limit` |
| `skool_pending_members` | Pending join requests with the applicant's application answers (admin) | `page` |
| `skool_calendar` | Events (upcoming by default) | `includePast`, `limit` |
| `skool_list_conversations` | DM inbox with unread counts | `limit`, `unreadOnly` |
| `skool_get_conversation` | Messages in one DM | `channelId`, `limit` |
| `skool_discover_communities` | Search Skool's public directory of communities **you have not joined** | `query`, `category`, `price`, `type`, `sort`, `language`, `page` |
| `skool_search_posts` | Keyword search inside a community — the only way to reach old posts | `query`, `page`, `limit` |
| `skool_notifications` | This account's notifications across **all** its communities | `limit`, `unreadOnly` |
| `skool_leaderboard` | Top contributors (7d / 30d / all-time) + level distribution | `period` |
| `skool_analytics` | **Admin only.** Everything in Skool's admin analytics, in one call that returns only the `views` asked for: `snapshot` (weekly check-in record, default), `overview`, `charts`, `sources`, `members`, `paid`, `courses` | `views`, `charts`, `from`/`to`, member filters, `fields`, `limit`/`page`, `summary`, `excludeHandles` |
| `skool_list_courses` | Courses in the classroom, with their slugs | `community` |
| `skool_get_course` | One course's section/lesson outline, plus **this profile's own** completed lessons | `courseSlug` |
| `skool_get_lesson` | One lesson: body rendered to markdown, resources, video info | `courseSlug`, `lessonId?` |
| `skool_get_transcript` | Spoken transcript of a lesson's video | `courseSlug`, `lessonId?`, `startSegment` |
| `skool_post_likers` | Which members liked a post or comment | `postId`, `limit` |
| `skool_search_gifs` | Search GIFs to attach (queries Giphy; needs no Skool session) | `query`, `limit`, `offset` |
| `skool_raw_get` | Debug: authenticated GET on any skool.com URL | `url` |

Write (profile required; these publish under that account):

| tool | what it does | main params |
|---|---|---|
| `skool_create_post` | New feed post. **Category (`labelId`) is required in communities that enforce categories** | `title`, `content`, `labelId`, `gif?` |
| `skool_create_poll` | New feed post **with a poll on it** (creates the poll, then the post) | `title`, `options[]`, `labelId`, `gif?` |
| `skool_create_comment` | Comment on a post, or reply to a comment via `parentCommentId` | `postId`, `content`, `parentCommentId?`, `gif?` |
| `skool_like` | Like/unlike a post **or a comment**; no-op if already in that state | `postId`, `action` |
| `skool_edit_post` | Edit a published post/comment you own. Partial: omitted fields stay put. No notification | `postId`, `title?`, `content?` |
| `skool_delete_post` | Delete a post/comment you own | `postId` |
| `skool_approve_member` | Approve a pending join request (admin); `membershipId` from `skool_pending_members` | `membershipId` |
| `skool_send_message` | Send a DM to a `channelId` or straight to a `userId` (opens the thread, or reuses an existing one). Permanent — DMs cannot be deleted by anyone | `channelId?`, `userId?`, `content`, `gif?` |
| `skool_mark_read` | Mark a DM conversation read | `channelId` |
| `skool_create_course_item` | New course, section or lesson (admin). **Always created as a draft**; a lesson can carry its markdown body and a YouTube video | `type`, `title`, `courseSlug?`, `sectionId?`, `body?`, `videoUrl?` |
| `skool_edit_course_item` | Change an existing course/section/lesson (admin). Partial: omitted fields stay put. Never touches publish state | `courseSlug`, `itemId`, `title?`, `body?`, `videoUrl?` |
| `skool_set_published` | Publish or unpublish a course/section/lesson (admin); reports whether members can actually see it | `courseSlug`, `itemId`, `published` |

Responses are JSON text, capped at 25k characters (lower `limit` or paginate if truncated). Errors come back
tagged `[auth]`, `[edge]`, `[notfound]`, `[ratelimit]`, `[http]` so it's clear whether a token, Skool's CDN, or
an endpoint is the problem.

### Attachments: why a comment can look empty

A comment whose whole message is a GIF has **no `content` key at all** — not an empty string, absent. Skool
carries the GIF as an attachment instead. This is ordinary behaviour in an active community, not an error and
not a failed read.

Posts and comments therefore carry an `attachments` field whenever something is attached, and omit it entirely
otherwise:

```json
{ "id": "14b6b99f…", "content": "", "author": { "name": "Jane Doe" },
  "attachments": [ { "id": "8dc13e73…", "type": "image/gif", "fileName": "biting-nails.gif",
                     "url": "https://media1.giphy.com/…/200.gif", "thumbnailUrl": "…/100.gif" } ] }
```

`type` is the MIME type (`image/gif` is the common case, sourced from Giphy; images and videos behave the same
way) and `fileName` usually conveys the intent without fetching the file. A `videoIds` field means a
Skool-hosted video is embedded. Empty `content` **and** no `attachments` is the genuinely odd case.

Skool stores this as `metadata.attachments` (comma-joined ids) plus `metadata.attachments_data`, a JSON
*string*. The feed/next-data routes return the ids without the records, so a post from `skool_list_posts` may
show attachments with `url: null`. Comment threads (`skool_get_comments`, `skool_get_post`) carry the full records, but
shorten each attachment to `{ type, fileName }` by default because the GIF urls are very long; pass
`attachmentUrls: true` to `skool_get_comments` for the whole record.

### Comment paging: `skool_get_comments`

Skool pages a post's comments, and until 2026-10-10 this server read only the first page: a post with 175 comments
showed 10 threads and then stopped cleanly, with no way to reach the rest. The tool now pages with Skool's own cursor.

`GET api2 /posts/{id}/comments?group-id=` — what Skool actually does, verified live on a 175-comment post:

- **The unit is a top-level thread**, replies nested inside it and not paged separately (depth 2: replies to replies
  are flattened under the thread). Default page is 10 threads. `limit` is honoured up to **30**; 31+ is HTTP 400
  `invalid limit`.
- **Cursor is a microsecond timestamp**, returned as the top-level `last`. Oldest first: send `created-gt=<last>`.
  Newest first: the first page is `tail=1`, then `created-lt=<last>` — each page is the window just before the
  cursor, ascending inside it, and `last` is its oldest thread. `last: 0` means nothing further. `tail` together
  with `created-lt` is refused (`multiple pagination parameters not supported`). An ISO string in `created-gt` /
  `created-lt` is silently ignored.
- **Pinned threads are not in the list.** They come back only with `pinned=1`, in a separate `pinned_post_tree`.
  On the verification post: 168 listed + one pinned thread of 7 = the post's own counter of 175.

The tool wraps the cursor as `after:<µs>` (oldest first) or `before:<µs>` (newest first), so a cursor can never be
used in the wrong direction. Every response says `totalComments`, `count` (threads), `commentsInPage` (replies and
pinned included), `hasMore` and, when there is more, `nextCursor` and a `next` sentence. `skool_get_post` returns the
same under `commentsPage` and puts the pinned thread under `pinnedComments`.

A page is also cut to a character budget, because a thread averages ~2k characters and the output cap is 25k: the
whole verification post is ~100k. When that trims a page, `trimmedForSize` is true and the cursor is derived from the
last thread actually returned, so nothing is skipped. At least one thread is always returned, so a single huge
thread cannot stall the walk — but it is atomic, and one thread larger than the cap would still be cut by the
generic truncation.

`node scripts/comments-test.mjs [postId] [community]` re-proves all of this read-only (every comment reached in both
directions, no duplicates, pinned once, nothing over the cap, bad cursors refused).

### Classroom: courses, lessons and transcripts

Four tools, used in order: `skool_list_courses` → `skool_get_course` → `skool_get_lesson` → `skool_get_transcript`.
They exist because the raw route is full of traps that cost a session to rediscover:

- **The course route always redirects.** `/{slug}/classroom/{courseSlug}` answers with a 200 whose *body* is
  `{"__N_REDIRECT": "…?md=<firstModuleId>"}` — a Next.js redirect smuggled inside a normal response, not an
  HTTP 3xx. `skool_get_course` follows it to discover the first lesson.
- **The outline has no lesson text.** The tree returns titles and `videoId` only. A lesson's body, resources
  and transcript appear *only* when that lesson is the selected `md=`, so reading content costs one request
  per lesson. Nothing is broken when the outline looks empty — that is simply how Skool ships it.
- **Lesson bodies are ProseMirror JSON** behind a literal `[v2]` prefix, not text or HTML.
  `normalize.richText()` renders them to markdown.
- **The course slug is an opaque segment** (`a6f22441`), never the title. Take it from `skool_list_courses`.

Structure is course → `set` (section) → `module` (lesson).

#### Building courses: create, edit, publish

Three admin-only tools: `skool_create_course_item`, `skool_edit_course_item`, `skool_set_published`. Skool calls a
course, a section and a lesson all a "course", told apart by `unit_type` (`course` / `set` / `module`), so every
route below takes any of the three. Shapes come from Skool's own web client (`apiClient` in `pages/_app` and the
classroom page chunks) and were verified live on 2026-09-23.

| action | route | notes |
|---|---|---|
| create | `POST /courses` `{group_id, unit_type, state, root_id, parent_id, metadata:{title, desc, video_link, video_len_ms, video_thumbnail, resources, privacy, …}}` | fields **nested under `metadata`**; `user_id` is filled in from the session; `root_id`/`parent_id` omitted for a course |
| edit | `PUT /courses/{id}` `{title, desc, video_link, …}` | fields at the **top level**; a verified **partial** |
| publish | `PUT /courses/{id}/state?state=published\|draft` | the **word**, not the number the unit reports (2 = published, 1 = draft) |
| video lookup | `POST /video-meta?url=&width=1280` | `{provider, video_id, thumbnail, len_ms, title}`; 400 for a video that does not exist |

Things worth knowing, each found the hard way:

- **Everything is created as a draft.** Skool's own editor creates new lessons *published*; these tools
  deliberately don't. Going live is only ever `skool_set_published`.
- **Publishing does not cascade.** Members see an item only when it *and every section and course above it* are
  published: a published lesson inside a draft section stays invisible (checked from a member account, which saw
  neither the draft test course nor a draft section inside a published course). So
  `skool_set_published` reports `visibleToMembers` and names any draft parent in `hiddenBy`.
- **Notifications on publish: none seen, but not proven.** Skool's classroom editor has no "notify members"
  option and the state route carries no notify flag, and publishing a test lesson produced no notification for a
  member. That test could only use items members could not see, so the tool description says so.
- **Edits are partial.** A title-only `PUT` left a lesson's body, YouTube video and resources byte-identical.
  Skool's editor relies on it too: renaming a folder sends only `title`, and resources go only when they changed
  (as an array, with `update_resources: true`). The first draft of the edit tool re-sent every field "to be safe",
  including `resources` as a string, a shape Skool's editor never sends; that was removed once the partial was proven.
- **Skool does not fill in video details itself.** Its editor calls `/video-meta` first and stores what comes back.
  YouTube's answer carries `hqdefault` as the thumbnail; the editor then HEAD-probes `i.ytimg.com` from
  `maxresdefault` down and keeps the first that exists. The tools do the same, which is why a lesson added through
  them is indistinguishable from one added by hand (length 3,205,000 ms and `maxresdefault.jpg` for the same video,
  matching the lesson set up in Skool's UI). Removing a video is `video_link: ""`, `video_thumbnail: ""`,
  `video_len_ms: 0`. Only YouTube is supported; a video *uploaded* to Skool (`videoId`, on Mux) is refused rather
  than overwritten.
- **Titles: 50 characters, counted as characters.** 51 is HTTP 422 `"Title is too long"`, and a 422 rejects the
  whole body, so nothing is written. 26 emoji (52 UTF-16 units) pass, so the check counts code points; zod's
  `.max()` would have wrongly refused emoji titles. Course descriptions are plain text, capped at 500 by Skool's form.
- **The lesson body round-trips.** Every markdown construct the converter emits (headings, bold, italic, code,
  links, line breaks, bullet and numbered lists, rules) was written and read back as the same markdown. Skool
  re-serializes the JSON (`marks` before `text`), so compare parsed rather than as strings.
- **The course page can only be opened on a lesson.** `?md=` set to a section's or the course's own id is HTTP 400,
  so items are read from the tree of the default page instead. An **empty** course does not redirect at all: it
  answers 200 with `children: null`, which `coursePage` now handles (it used to throw).
- **The direct read doesn't work.** `GET /courses/{id}` is in the client but answers HTTP 400 with an empty body
  whatever query it is given, so reads stay on the Next.js page route.
- **The security nonce doesn't apply.** Skool's client gates only `/auth/*` routes with it; course writes need
  nothing beyond the session cookie.
- **Deleting is not exposed, and for a course it is impossible from the server.** `DELETE /courses/{id}` works for a
  lesson or section. For a course it answers 400 `invalid client ID`, and with a `client_id` it answers
  401 `email verification required`: Skool's client marks it `requireEmailVerification`, which means a code emailed to
  the account. Reordering (`/move2`), moving (`/update-parent`), access locks, cover images and resources are left to Skool.

#### Video transcripts, and the 50-subrequest ceiling

Lesson video is hosted on Mux and auto-captioned. Skool's own `transcript` field exists but is normally
empty; `skool_get_transcript` returns it when set and falls back to the captions otherwise.

There is **no single-file transcript URL**. Mux's `/text/{trackId}.vtt` route exists but needs the AssetTrack
id, which Skool does not expose — `api2 /videos/{id}` returns only `duration` and `status` (checked
2026-09-07). So the transcript is assembled from 30-second WebVTT segments: 2 subrequests for the manifests,
then one per segment.

There are two routes, and the guide tells Claude to pick deliberately between them.

**With a shell (Claude Code), do it in one pass.** No limits, and it is much faster. `skool_get_transcript`
returns a `manifestUrl` for exactly this; the guide carries the full recipe. Measured on a 64-minute
recording: **129 segments, 4,018 words, 4.2 seconds**. Two details the recipe gets right and a naive version does
not — `xargs -P` interleaves stdout, so segments must be written to numbered files or the transcript comes
back scrambled; and duplicate cues repeat across segment boundaries, so consecutive duplicates need
collapsing (otherwise you get `[Bang!]` eight times).

**Without a shell (Claude web/mobile), the tool pages.** Cloudflare hard-caps a Worker request at 50
subrequests — measured on this account 2026-09-07: attempting 60, 150 and 400 each succeeded exactly 50
times, then threw `Too many subrequests by single Worker invocation`. That is the free-plan limit (paid is
1000). So `MAX_CAPTION_SEGMENTS = 45`, giving **~22 minutes of video per call**; most lessons are a single
call, and longer recordings return `nextStartSegment`. For a very long recording with no shell available,
the guide says to escalate to someone who can run route (a) rather than paging a dozen times.

> An earlier version of these notes claimed "~13k words in a few seconds" and implied a whole transcript
> could be pulled in one go. That figure was wrong, and it was measured with `curl` on a laptop — which is
> route (a), where no subrequest limit applies. It never held inside the Worker.

Two header rules, easy to get backwards: the **two manifest requests require** `Referer: https://www.skool.com/`
(the playback token carries a `playback_restriction_id` and returns 403 without it), while the **segment URLs
are individually pre-signed and need no headers at all**. Playback tokens last ~24h. Captions are
machine-generated — expect `[Music]`, `[BLANK_AUDIO]` and mis-hearings.

### Notifications, search and leaderboard

- `skool_notifications` — `api2 /self/notifications?type=all`. The list-type param is **`type`**; `lt` and
  `list_type` both return HTTP 400 `invalid list type`. Spans every community the account belongs to. Each
  item's `metadata.data` is a JSON string; inside it, `link_as` is the real post URL — `link_href` is the
  Next.js route *pattern* (`/[group]/[post]`) and is useless as a link.
- `skool_search_posts` — the `/-/` path segment is required; without it `q` is silently ignored and Skool
  returns the unfiltered feed, which looks like a search that matched everything.
- `skool_leaderboard` — `/-/leaderboards` gives `allTime` / `past30Days` / `past7Days` (top 10 each) plus
  `groupLevels` with the share of members at each level.
- `skool_get_post` now resolves **any** `postId` regardless of age. `api2 GET /posts/{id}?group-id=` returns
  the post but omits the `user` record, so the tool resolves id → slug → post page to keep the author.
- `skool_community` also returns the community rules and the level ladder.

### Analytics: `skool_analytics`

One read-only tool for everything Skool's admin analytics shows, because a tool per chart would add sixteen
descriptions to every session's floor for a feature used once a week. The caller picks `views`, and only those are
fetched. Admin-only: a profile that is not a community admin gets HTTP 401, which the tool turns into a plain "use the admin profile".

| view | what | Skool source |
|---|---|---|
| `snapshot` (default) | The weekly check-in record for a 7-day window ending yesterday (or `from`/`to`): the three member counts, avg/min/max daily active, weekly and monthly active on the last day, activity events, joined and left (with sources, names optional), paying count and monthly income minus `excludeHandles`, started paying, cancelling, and last-30-days visitors and signups by source | everything below |
| `overview` | Daily / weekly / monthly active (latest + 30-day series), the daily-activity heatmap, Dashboard and Growth headlines | `GET /groups/{id}/admin-metrics?range=30d&amt=daily\|weekly\|monthly`, `analytics-overview-v2`, `analytics-growth-overview-v2` |
| `charts` | Any of Skool's 16 charts by name; default a short list | `GET /groups/{id}/analytics-v2?chart=` |
| `sources` | Joins by source, source detail and referrer over **any** dates, plus departures | member records |
| `members` | Filtered member counts (`summary: true`, default) or rows with only the `fields` asked for | `{slug}/-/members` next-data, with `t=` and billing filters |
| `paid` | Paying members, monthly income, started paying in a window | same, `monthly=true&annual=true` |
| `courses` | Every member's lessons completed per course: distribution, started, finished, median; rows opt-in | the nightly collection (below), from `GET /groups/{id}/member-course-permissions?progression=true&member=` |

Every number goes out as `{value, what, window, screen}` — the screen names (Admin settings → Dashboard, → Growth,
Members page, About page) are Skool's own, taken from its web client. Things found the hard way, all verified live
2026-10-10:

- **"Members" is three numbers.** The Members page Active tab (say **N**) leaves out admin accounts — even though the
  admin is still a row in that list (N + 1 rows, `total: N`, `totalAdmins: 1`). The About page's `total_members`
  (**N + 1**) counts the admin, as does the Dashboard headline. admin-metrics `total_members` also counts the admin but
  is a once-a-day snapshot: on the day it was checked it still included a member who had left that afternoon, so it
  read one higher again. The Active-tab figure is the one to log week to week; the tool reports all three, labelled.
- **"Active members" is three numbers too**: `amt=daily|weekly|monthly` changes only `active_members` (e.g. 20 / 35 / 43
  on one day). `latest_active_members` is the monthly figure whatever `amt` says. Series come newest-first.
- **Only `range=30d` exists** (`90d`, `7d` → 400 `unsupported time range`), so Skool forgets this after 30 days —
  which is why the weekly snapshot is worth saving somewhere of your own each week.
- **Daily activity** counts likes, posts, comments and poll votes (Skool's own wording), in **UTC** days, while the
  active-member buckets look like local days. The array is unlabelled; index *i* = `start_date` + *i*, and the code
  checks on every call that `counts.length` equals the inclusive `start_date → end_date` span (364 = 364), so
  `end_date` is the last, still-filling day.
- **The two-step token.** Most charts and both overview routes first answer `{"token": "…"}`; the same call with
  `&token=` returns the data. Tokens expire within minutes. `members` answers directly.
- **All 16 chart names exist.** On Hobby, `mrr_unit`, `members_cohorts` and `retention_cohorts` answer 400
  `not_allowed_for_hobby_plan`, reported as a plan limitation. `conversion_trials` returns `items: null` (no trials).
  By-source charts are a rolling 30 days with no date parameter, so weekly joins by source come from member records.
- **Units differ by route.** `analytics-overview-v2` sends MRR in **cents** (2700); `analytics-v2` and the growth
  overview send **dollars** (`mrr: 30`, `new_mrr: 15`). Output is dollars throughout.
- **Member-list filters**: `t=cancelling|churned|banned`; `monthly`/`annual`/`oneTime`/`trials`/`free=true` (several
  together are OR-ed), `tiers=premium`, `levels=N`. Billing filters are **ignored on the churned tab**. The only working
  sort is the default newest-join-first (ascending → 500); the churned tab is newest-departure-first. Both orders let
  a dated read stop early. Each `tabChips` count is right only for the tab being read.
- **Per-member records**: `approvedAt` (join), `metadata.attrComp` / `attrSrcComp` (source / detail), `aflUser` +
  `aflUserData` (referrer), `member.churned` with `leftAt` (left) or `removedAt` [+ `removedBy`] (removed). Paid:
  `mmbp` (JSON: amount in cents, interval, tier), `mbscpe` (renewal, unix seconds), `mbsltv` (lifetime paid, cents).
  First payment ≈ `mbscpe` − (`mbsltv` ÷ amount) intervals — exact on 4 known upgrades. `mmbp` matched Skool's
  monthly filter exactly, and the summed prices matched Skool's own MRR. Emails (`email`, `mbme`,
  `searchAnswer`) and Stripe ids (`msbs`) are never returned.
- **Size and limits.** `summary: true` (default) returns counts only, at any community size. Rows are opt-in, capped at
  100 per call. Full counts cost one request per 30 members, read sequentially with a 250 ms pause. Every Skool call
  counts against a budget of 45 (Cloudflare allows 50); when it runs out, or Skool rate-limits, the result carries
  `partial: true` and the reason instead of failing. The default snapshot costs 17 calls; all six views together, 26.
  Snapshot calls grow only with the week's joins and departures and with the number of payers (each list read
  stops at the window's start): 14 fixed + one per 30 joins + one per 30 departures + one per 30 payers.
- **CPU.** Each members page is 270–370 KB of next-data (~260 KB fixed page shell + ~3.5 KB per member). The free plan
  lists 10 ms CPU, but on 2026-10-11 `wrangler tail` showed the deployed daily health check — which parses ~18 such
  pages — using **123 ms CPU with outcome `ok`**, so that figure is not a hard cut-off for this Worker today. Relative
  to that: the snapshot reads ~6 pages, a full `members` summary at 1,000 members reads 34 (roughly twice the health
  check). If Cloudflare starts enforcing it, the health check fails first and alerts.
- **Payment history, verified 2026-10-11, not wired into a tool:** `GET /members/{membershipId}/invoices` (Skool's
  `getMemberPaymentHistory`; never its sibling `POST /members/{id}/invoices/`, which retries a charge) returns
  `{invoices: [...], has_more, next_page}`, newest first. Each charge has `charge_created_at` (unix seconds), `status`,
  `amount` (cents), `currency`, `tax`, `refunded`, `disputed`, attempt counts, and the payer's card or wallet
  (country, last4, brand, expiry). A free member gets `invoices: null`. On three payers the actual charge dates
  matched `firstPaidEstimate` to the day. Payers in a VAT country were charged 357 cents for a 300-cent plan (×1.19, which
  matches that country's VAT) while `tax` read 0 and `mbsltv` counted 300 per charge, so plan price ≠ amount charged.

#### Course progress, and the nightly collection

`skool_get_course` returns the **reading profile's own** progress: `progress.lessonsCompleted` (Skool's
`course.metadata.userCompleted`, a **count**) and `completedByProfile` on each lesson (`metadata.completed: 1`, absent
when not done).

**Every member's** progress is readable by an admin, one member per call:
`GET /groups/{groupId}/member-course-permissions?progression=true&member=<membershipId>` (Skool's
`getMemberCoursePermissions`, used by the member-settings modal). With `progression=true` each published course's
`metadata` carries `user_completed` (a count) beside `num_modules`; drafts come back without it. `member` must be the
**membership** id (a user id is HTTP 500), and there is no bulk form (empty, comma-joined or `members=` → 400). It is a
count per course, not which lessons, and Skool keeps no history of it. Verified 2026-10-11 against four members' own
views.

**What a count means depends on how the lesson's video is hosted** (tested by hand on 2026-10-11): a video *uploaded*
to Skool (`metadata.videoId`) marks the lesson done automatically once the member reaches **90%** of it — reaching,
not watching, so scrubbing counts. A *YouTube link* (`metadata.videoLink`, hosts `youtu.be` / `youtube.com`) marks it
done **only when the member presses Done**, so counts on those lessons are a floor. Any other linked provider (Loom,
Vimeo, Wistia, …) is classified by its host and reported separately as `linkedOther`; **its behaviour is untested**, so
treat it as Done-button until someone checks. The nightly walk reads each published course's outline once (1 + 2
calls per course) and stores `lessonsByVideo` per course (`uploaded`, `youtube`, `linkedOther`, `noVideo`; published
lessons only, matching Skool's `num_modules`); `skool_get_course` shows each lesson's `videoKind`. A course mixing uploaded and YouTube
lessons therefore shows counts that undercount the YouTube ones.

One call per member does not fit the 50-subrequest cap, so `src/progress.ts` collects it **nightly on Cloudflare** — no
laptop or Claude session involved. The single cron trigger now fires every 3 minutes 06:00–08:57 UTC: the 08:00 run is
the health check, every other run is one **step** (up to 46 Skool calls: list the members, then read their progress,
keeping its place in KV). Only a complete night replaces `course-progress:latest`, which the `courses` view and the
snapshot read (a KV read, not an external subrequest). ~50 members take two steps; 1,000 members take ~23, done by
about 07:10 UTC. KV cost: about 3 writes a night at ~50 members, ~26 at 1,000, of the free plan's 1,000 a day. The health check
fails if the last complete night is over 26 hours old. `GET /course-progress` (same key as `/healthcheck`) shows the
night's state and `lastError`; `?step=1` runs one step on demand.

### Discovery: communities you have not joined

`skool_discover_communities` reads Skool's public directory (the `skool.com/discovery` page) through its
Next.js data route; `skool_community` reads any community's About page from `api2 /groups/{slug}` — the
long About body, prices, member/post/course counts, review rating, the questions asked of applicants, and the
owner. Both work **without authentication and without joining**.

Discovery filter params, verified 2026-09-07 by driving the real filter UI. The obvious guesses are wrong:
`t` / `s` / `page` are silently ignored, and an invalid value renders Skool's "Oops" page rather than falling
back to a default.

| param | values |
|---|---|
| `q` | free-text search |
| `c` | `hobbies` `music` `money` `spirituality` `tech` `health` `sports` `self_improvement` `relationships` |
| `pr` | `free` `paid` `free-trial` |
| `ty` | `private` `public` |
| `srt` | `trending` `top` |
| `lang` | lowercase language name (`english`, `spanish`, … 48) |
| `p` | page; 30 results per page |

`numGroups` is the real match count but saturates at 1000 (~34 pages), and `hasMore` is unreliable — judge
"more pages" by whether a full 30 came back.

**Reading a non-joined community's feed.** When a group record carries top-level `public: true` (equivalently
`privacy: 0`), a non-member can read its entire feed and comment threads with the ordinary tools — just pass
its slug as `community` to `skool_list_posts` / `skool_get_post` / `skool_get_comments`. Verified against
`earth2` (515 posts, full content and comments, from an account that has not joined). When `public` is absent,
the feed 307-redirects to `/about` and the tools return `[auth]`; only `skool_community` works. Each
discovery result reports this as `publicFeed`, so it is visible before you try.

The slug is the URL segment (`earth2`), never the display name (`Earth 2.0 Community`).

## Maintenance

**When something breaks.** Skool changes its internal API without notice. Symptoms: a tool returns
`[http] HTTP 4xx` or `[parse]`. Fix path: (1) run `node scripts/smoke.mjs` to see which tools fail;
(2) open the same page in Chrome with DevTools → Network, do the action by hand, copy the request
(URL, method, body); (3) change only `src/skool.ts` — every endpoint literal is there; (4) typecheck, deploy,
re-run the smoke test.

Before concluding Skool cannot do something, check [SKOOL-ENDPOINTS.md](SKOOL-ENDPOINTS.md) — all 340
endpoints its web client calls, with the ones already wired up marked. Refresh it with
`node scripts/extract-endpoints.mjs` after a Skool deploy; it re-reads the live chunk and re-derives which
endpoints `src/skool.ts` uses, so the ✅ column cannot drift out of date.

Two actively maintained open-source projects track the same endpoints and are a good
place to look for the new shape first:
[Solnest-AI/skool-mcp-community](https://github.com/Solnest-AI/skool-mcp-community) (`endpoints.md`) and
[elchamoluso/skool-mcp-kit](https://github.com/elchamoluso/skool-mcp-kit) (`lib/skoolapi.js`).

**Automatic detection.** A cron trigger (`wrangler.toml` → `[triggers]`, daily 08:00 UTC) runs `src/healthcheck.ts`:
for every profile with a token it decodes the token's expiry and exercises every read endpoint the tools use (whoami,
community, labels, feed, post page, comments, members, pending, search, calendar, DM inbox, DM messages). For the first
profile only it also checks the classroom (the course index, one course's outline, and the `POST /video-meta` lookup the
course-building tools use to attach a YouTube video, against "Me at the zoo", YouTube's oldest video, as a stable target)
and analytics (admin-metrics with the daily-activity date alignment, the two-step token on `analytics-overview-v2` and on
a chart, a direct chart, the churned tab, the billing filter, and the member-record fields `skool_analytics` counts from).
Those run once rather than per profile because the whole check is one Worker invocation under the free plan's
50-subrequest cap, plus course progress (one member's progress read, and the age of the last nightly collection).
Measured with three profiles: **45–46 subrequests** — buildId fetched once up front (it used to be
fetched by each profile in parallel) and the DM inbox read once per profile (it used to be read twice). With one profile,
about 28.

**Comment paging** (`skool_get_comments`) is checked on every run, at a cost of 2 extra requests: the per-profile
comments check now reads the busiest post on the first feed page the way the tool does (`tail`, `limit` 30, `pinned`), and
fails if a thread's shape changed, the window is not oldest-to-newest, `limit` is ignored, `last` is no longer the boundary
thread's `created_at`, or the post's own comment counter and what paging reads differ by more than 2 (the tolerance comes
from a 113-post survey: 81 of 81 exact in a small community, 2 large posts in the public Skoolers community a few off). For the first profile
only, a second check takes the post's two newest threads and requires `created-gt` to return exactly the newer and
`created-lt` exactly the older, each with `limit: 1` honoured — the continuation every page after the first depends on.
Each failure mode was injected into an in-memory Skool to confirm it is caught (limit ignored, either cursor ignored,
`last` in the wrong unit, pinned thread dropped). Measured with three profiles: **47 subrequests** (48 with the Telegram message on a failure).

**Every new tool or endpoint gets a health-check entry in the same change** — that is the standing rule, because the
daily run is the only thing that notices a silent Skool change. Recount the budget when adding one (the tally is at
the top of `src/healthcheck.ts`); past ~48, split the run into two cron entries rather than dropping coverage. If anything fails,
or a token has under 30 days left, it sends one Telegram message via a bot. Set `TELEGRAM_BOT_TOKEN` and
`TELEGRAM_CHAT_ID` as secrets to enable alerts (without them the check still runs, silently). Run it on demand:
`curl -H "x-mcp-key: <MCP_ADMIN_KEY>" https://<worker>/healthcheck`. Writes (post, comment, DM send, approve) are deliberately
not exercised, since each would publish something visible to members every day; a failing write tool in chat is still the signal for those.

**Two documentation surfaces, split on purpose.** `SERVER_INSTRUCTIONS` (~2.5k chars) is sent once at
connection, so every session pays for it; `USAGE_GUIDE` (~13k) is served only by the `skool_usage_guide` tool.
Both used to be the same string, which cost every session ~3,300 tokens for material most never needed.

What stays in the always-loaded half is deliberate: the capability map (so a session cannot wrongly conclude
something is impossible — the failure that actually happened on 2026-09-07) and the things that cannot be
undone (writes notify irreversibly; the userId is what tags). Per-tool gotchas live in the tool descriptions,
so they are visible even to a session that never opens the guide. Everything guessable-only-if-you-know —
the classroom redirect, the ProseMirror bodies, the transcript routes, the discovery params — sits in the
on-demand guide. Keep that split when adding to either.

**When Claude says a tool does not exist.** The connector's tool list is cached above the app, so a newly
deployed tool can be missing from a session — and restarting Claude does not necessarily refresh it. Observed
2026-09-07: new tools appeared in an existing session in batches over roughly an hour, while a freshly started
session still reported them missing. Confirm the server side before debugging anything else — query `tools/list`
directly rather than trusting a session's own account of what exists. To force a client refresh, toggle the
connector off and on in Settings → Connectors, or remove and re-add it.

The failure mode to watch for is a session concluding "this server cannot do X" and falling back to
`skool_raw_get` with guessed endpoint paths. `skool_raw_get`'s description and the guide's opening capability
map both exist to stop exactly that, since guessing re-walks traps the dedicated tools already handle.

**Token rotation.** Tokens last ~365 days from the login that created them. When a profile starts returning
`[auth]`, copy a fresh `auth_token` from a browser logged in as that user and run
`wrangler secret put SKOOL_TOKEN_<PROFILE>` again. No redeploy needed. Logging out of Skool in that browser
invalidates the token, so stay logged in.

**Rotating the URL.** `wrangler secret put MCP_PATH_SECRET` and/or `MCP_ADMIN_KEY` with new values, then update the
connector URL in Claude. Both halves of the URL are secrets; rotating either one invalidates every old URL immediately.

### Polls

`skool_create_poll` does both steps Skool requires: `POST /polls {group_id, options}` to create the poll
object, then `POST /posts` with `metadata.poll = <pollId>`. A poll is invisible until a post references it,
so there is deliberately no "create a bare poll" tool.

An optional `gif` is registered with the same `createGifFile` call `skool_create_post` uses, as the last step before
the post is created, and rides in the same `POST /posts` body as `metadata.poll` (`metadata.attachments` is a sibling
key). It cannot be added afterwards — `skool_edit_post` only changes title and content. Not yet exercised live: the
sibling-key shape is taken from the code and `normalize.post`, which already reads both off one post.

If registering the GIF fails, the just-created poll has no post and is deleted (`DELETE /polls/{id}`, best effort,
also not yet exercised live). That cleanup is deliberately skipped when `POST /posts` itself fails: the failure is
ambiguous, the post may have landed with the response lost, and deleting a poll a post references destroys its votes.

Results ride along on the post as `metadata.pollData`, so **any** post with a poll returns a normalized
`poll` field (option text, vote counts, and the members who voted) through `skool_get_post` and
`skool_list_posts` — no extra call. Skool also exposes `POST /polls/{id}/vote?idx=`, `/cancel-vote`,
`/change-vote`, `PUT /polls/{id}` and `DELETE /polls/{id}`; none are exposed as tools, since voting and editing as
one of the server's accounts had no use when this was built. (`DELETE` is wired in `SkoolClient.deletePoll`, used only for the cleanup
described above.)

### Likes

`PUT /posts/{id}/vote` with body `{old, new}` — `new: "up"` likes, `new: ""` unlikes, and `old` is the
current state. **The same endpoint and the same id handle comments**, because Skool models a comment as a
post; there is no separate comment-like route.

Skool uses `old` to compute the delta, so a stale value skews the count. `skool_like` therefore reads the
current state first and reports `changed: false` when there is nothing to do, which also makes a repeated
"like this" harmless instead of a silent unlike.

Reading the state is the part with a trap: the field is `my_vote` on api2 and `myVote` on the Next.js pages,
and it is **absent rather than `""`** when the account has not voted — so a check on one spelling reports
every post as unliked. `normalize.liked()` handles both; posts and comments expose it as `likedByMe`.

A like notifies the author and unliking does **not** retract that notification. Skool answers `429`
("Liking too fast") to rapid liking, so this is deliberately a one-at-a-time tool with no bulk mode.

`skool_post_likers` uses `GET /posts/{id}/vote-users`, **not** the more obviously named
`/posts/{id}/upvote-users`. Both return the same users, but `/upvote-users` hard-caps `limit` at 10 and
*rejects* anything above it — `HTTP 400 "invalid limit: 11"`, not a clamp — and takes no cursor, so the
eleventh liker onward is unreachable. `/vote-users` accepts a normal limit plus a `cursor`, and adds
`total_upvote_users` so the true count is reported even when one page does not hold it. Rows are flat user
records that include `email` on an admin session, which `normalize.author` drops.

### GIFs

Skool does not host GIFs and there is no upload. Its picker calls **Giphy directly** from the browser with a
public key shipped in the page, then stores only a reference. Posting one is three steps, which
`skool_create_post` / `skool_create_poll` / `skool_create_comment` do in one call when given a `gif`:

1. `GET api.giphy.com/v1/gifs/search` (`rating=pg-13` when there's a query, `g` without) → `images.fixed_height{,_small}.url`
2. `POST /files` with `{file_name, content_type: "image/gif", content_length: 0, external_src, external_src_small, large_thumbnail: false}` → `{file: {id}}` — no bytes uploaded; Skool derives its own `image_md_url`
3. the returned id goes into `metadata.attachments`, **comma-joined**, on the post or comment

`skool_search_gifs` is a separate read-only tool on purpose: it returns titles so the model picks a GIF that
fits rather than taking the first hit, and the chosen row is passed back unchanged (a hand-written Giphy URL
does not resolve). It needs no Skool session, so `SkoolClient.searchGifs` is static.

The key is Skool's own public client key by default, overridable with the `GIPHY_KEY` secret if it is ever
rotated or rate-limited — a free key from developers.giphy.com is a drop-in replacement.

Two behaviours worth knowing: Skool **garbage-collects a file no post references** (detaching one deletes it,
so ids cannot be minted ahead of time or reused), and `POST /posts/{id}/update` takes a **partial** body —
only the fields present are written, which is what makes adding an attachment to an existing post safe.

### Editing

`POST /posts/{id}/update` — **not** `PUT /posts/{id}`, which is what the shape looks like from outside. The
body is a **partial**: Skool writes only the keys present, so a content-only edit cannot blank the title.
Works on comments too, since Skool models a comment as a post.

Editing sends **no notification**. That is the useful part for a typo and the dangerous part otherwise —
the words members already read can change with nothing to signal it. `skool_edit_post` therefore returns the
previous title and content on every call, so a change can always be put back.

Skool also accepts `labels`, `attachments`, `video_links`, `video_ids`, `poll` and `delete_poll` on the same
route. None are exposed: they have no current use, and `delete_poll` destroys cast votes irreversibly.

### GIFs in DMs

`skool_send_message` takes the same `gif` argument as the post and comment tools, but the wire shape differs:
a DM's `attachments` is an **array of file ids**, while a post or comment carries the same ids as a
comma-joined **string** in `metadata.attachments`. Same `POST /files` registration either way. Passing one
encoding where the other belongs fails silently rather than erroring, so the two paths are kept separate in
`SkoolClient` rather than sharing a helper.

### Admin endpoints deliberately not implemented

Skool's own web client uses these, and they work with an admin session. They are recorded here so nobody has
to rediscover them, and left unimplemented on purpose:

`PUT /groups/{id}` (group settings) · `PUT /groups/{id}/levels/{n}` `{title}` (rename a level) ·
`POST /groups/{id}/update-name` · `/links` (the custom links in the community sidebar) ·
`/update-onboarding-video`, `/update-retention-video` · `POST /labels` (new category) ·
`/enable-lockdown`, `/disable-lockdown` · `/invite`, `/bulk-invite` ·
`POST /groups/{id}/delete-user-recent-posts` (destructive).

Editing a published post used to be listed here as `PUT /posts/{id}`. That was wrong on both counts: the
route is `POST /posts/{id}/update`, and it is now implemented as `skool_edit_post` — see Editing below.

`PUT /groups/{id}` is the risky one: it takes the whole settings body, so a partial write can clobber
settings. Lifecycle **DM automation** is also possible today from existing primitives — `skool_pending_members`,
member join dates, `skool_leaderboard` for who has gone quiet, and the DM tools — and is deliberately not
built. Automated outbound DMs to real members is a community-trust decision, not a technical one.

**Known limitations.**
- Member approval: `skool_approve_member` has approved real join requests. Declining is deliberately not exposed as a tool: it is a rejection of a real person
  and belongs in the user's hands, in Skool. `SkoolClient.setMemberRole` still accepts the role if wanted.
- Security is a secret URL (path secret + admin key) and Anthropic's IP range, not OAuth. Fine while only you and your team use it.
- Unofficial. Uses Skool's internal API via a session cookie; use with your own accounts, at human pace.

## Lessons from the original build

These came out of the original verification log and are worth keeping in mind for any change:

- **Exercise every tool through the deployed Worker before calling it done.** A tool whose HTTP calls were each
  verified on their own still failed on every call once deployed: `skool_post_likers` shipped with a default `limit`
  of 30 against `/upvote-users`, which refuses anything above 10.
- **Look at the output, not just the status.** Several tools "worked" while returning the wrong thing: a DM send
  echoed Skool's entire community record, the DM inbox read `lastMessage` from a field that does not exist (so it was
  `null` everywhere), and GIF-only DMs read as empty because attachments were dropped. Reading the wrong field
  returns nothing rather than erroring, so only comparing against the raw payload catches it.
- **Prove a write is partial before relying on it.** `skool_edit_post` and `skool_edit_course_item` only send the
  changed fields because a title-only edit was shown to leave the body byte-identical (hashed before and after).
- **Clean up after live write tests, and remember what cannot be cleaned up.** Deleting a post or comment does not
  retract the notification; a DM cannot be deleted at all; a course can only be deleted in Skool with an emailed code.
  Never tag anyone in a test post.
- **Every new tool gets a health-check entry in the same change** (see Maintenance), and the tool count and
  descriptions are kept lean on purpose: everything in a tool description is paid for by every session.

## Upstream references

- [louiewoof2026/skool-mcp](https://github.com/louiewoof2026/skool-mcp) — original API discovery notes (stale since 2026-03).
- [Solnest-AI/skool-mcp-community](https://github.com/Solnest-AI/skool-mcp-community) — Python, DM endpoints, tests.
- [elchamoluso/skool-mcp-kit](https://github.com/elchamoluso/skool-mcp-kit) — JS, token-lifetime measurements, calendar.
