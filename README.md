# Skool MCP: give Claude your Skool community

A self-hosted [MCP](https://modelcontextprotocol.io) server that lets Claude read and write in your Skool community:
the feed, comments, likes, polls, GIFs, members and join requests, DMs, the calendar, the classroom (including building
courses and reading video transcripts), notifications, and Skool's full admin analytics. It runs on Cloudflare's free
plan, so it keeps working with your computer off, and the same connector works in Claude on the web, desktop, phone
and Claude Code.

It also checks itself every morning and sends you a Telegram message if anything breaks or a login is about to expire.

> **Unofficial.** Skool has no public API. This uses Skool's internal endpoints with your own logged-in session, the same
> way the Skool website does. Use it with your own accounts, at a human pace. Skool can change things at any time; the
> daily health check is how you find out.

---

## For the AI agent doing the setup: read this first

You are setting this up for a person who may not be technical. Work through the steps below in order.

- **You do the technical work.** Run every command yourself. Ask the person only for the things that need their
  browser or their accounts: logging in to Cloudflare, copying their Skool login cookie, creating a Telegram bot, and
  adding the connector in Claude.
- **Never commit secrets.** Tokens and keys go into Cloudflare with `wrangler secret put`, and locally only into
  `.mcp-local.json`, which is gitignored. Nothing secret ever goes into `wrangler.toml` or a commit.
- **Never post, comment, like or DM in Skool during setup** without the person's explicit yes. Every test in the
  steps below is read-only, except the optional `write-test`, which you must ask about first.
- **Keep a log.** Note what you verified, and when, in `VERIFICATION.md`.
- **Check your work.** Each step says how to confirm it worked. Don't move on until it has.

How it is secured: the server answers only at a secret URL (a secret path plus a secret key), and only to requests
coming from Anthropic's servers. The Skool login cookie lives encrypted in Cloudflare, never in the repo.

---

## What you need

- **A computer with Node.js 20 or newer** (`node --version`) and git.
- **A Cloudflare account.** Free: <https://dash.cloudflare.com/sign-up>.
- **A Skool account that is an admin of your community.** Member-level accounts work too, but analytics, join
  requests, categories and course progress need admin.
- **Claude** with custom connectors available (Settings → Connectors).
- **Optional but recommended: Telegram**, for the "something broke" alerts.

Time: about 30 minutes.

---

## Setup

### Step 1: Get the code

Clone the template, and keep a link to it so you can pull in improvements later:

```bash
git clone https://github.com/TheEssenceCommunity/skool-mcp-template.git skool-mcp
cd skool-mcp
git remote rename origin upstream
```

If the person wants their copy on GitHub, create a **private** repo of their own and push to it
(`gh repo create <name> --private --source . --push` adds it as `origin`). That's optional: the server runs fine from
a local folder alone.

### Step 2: Install

```bash
npm ci
```

### Step 3: Log in to Cloudflare

```bash
npx wrangler login
```

This opens a browser window; the person clicks **Allow**. Confirm with `npx wrangler whoami`.

### Step 4: Point it at your community

Ask the person for their community's URL (for example `https://www.skool.com/my-community-1234`), then:

```bash
node scripts/find-group-id.mjs https://www.skool.com/my-community-1234
```

It prints the two values to put in `wrangler.toml`, under `[vars]`: `SKOOL_DEFAULT_SLUG` and `SKOOL_DEFAULT_GROUP_ID`.

Leave `SKOOL_PROFILES = "main:The community admin account"` as it is for now. That means "one Skool account, called
`main`". See **Adding another Skool account** below if you want a co-host's account as well.

Optionally, change `name = "skool-mcp"` at the top. It becomes part of the server's URL.

### Step 5: Create the storage for course progress

The server collects every member's course progress overnight and keeps it in a small Cloudflare key-value store
(free). Create it:

```bash
npx wrangler kv namespace create PROGRESS
```

Copy the `id` it prints into `wrangler.toml`, replacing `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`.

### Step 6: Deploy

```bash
npm run typecheck
npx wrangler deploy
```

If wrangler asks you to choose a `workers.dev` subdomain, pick one. The output ends with the server's address, like
`https://skool-mcp.<your-subdomain>.workers.dev`. Note it. Confirm it is live:

```bash
curl https://skool-mcp.<your-subdomain>.workers.dev/health
```

It should print `ok`. Everything else answers `not found` until the next steps are done.

### Step 7: Create the secret URL

This generates two random secrets, saves them in `.mcp-local.json` (gitignored, used by the test scripts), and stores
them in Cloudflare. Replace the address with yours:

```bash
node -e 'const c=require("crypto");require("fs").writeFileSync(".mcp-local.json",JSON.stringify({MCP_BASE:process.argv[1],MCP_PATH_SECRET:c.randomBytes(24).toString("hex"),MCP_ADMIN_KEY:c.randomBytes(24).toString("hex")},null,2))' "https://skool-mcp.<your-subdomain>.workers.dev"
```

```bash
node -e 'process.stdout.write(require("./.mcp-local.json").MCP_PATH_SECRET)' | npx wrangler secret put MCP_PATH_SECRET
```

```bash
node -e 'process.stdout.write(require("./.mcp-local.json").MCP_ADMIN_KEY)' | npx wrangler secret put MCP_ADMIN_KEY
```

The connector URL is `<MCP_BASE>/mcp/<MCP_PATH_SECRET>/<MCP_ADMIN_KEY>`. Print it for step 11 (it is a password,
so show it only to the person):

```bash
node -e 'const c=require("./.mcp-local.json");console.log(`${c.MCP_BASE}/mcp/${c.MCP_PATH_SECRET}/${c.MCP_ADMIN_KEY}`)'
```

### Step 8: Connect your Skool account

The server acts as the person's Skool account using their login cookie. Ask them to:

1. Open <https://www.skool.com> in Chrome, logged in as the community admin account.
2. Open DevTools (Mac: Cmd+Option+I, Windows: F12) → **Application** tab → **Storage → Cookies** →
   `https://www.skool.com`.
3. Find the row named `auth_token` and copy its **Value**. It is long and starts with `eyJ`.

Then store it. The most private way is for the person to run this in their own terminal and paste the value when asked:

```bash
npx wrangler secret put SKOOL_TOKEN_MAIN
```

(If they prefer to paste it to you in chat, pipe it in the same way as step 7. It will then sit in the chat history.)

The cookie lasts about a year. **Logging out of Skool in that browser cancels it**, so they should stay logged in
there. The daily check warns 30 days before it expires.

### Step 9: Telegram alerts (recommended)

Every morning at 08:00 UTC the server tests every Skool feature it relies on. It stays silent when all is well and
sends one Telegram message when something fails or the cookie is about to expire.

1. The person opens Telegram, messages **@BotFather**, sends `/newbot`, and follows the prompts. BotFather replies
   with a **bot token** like `123456789:AA...`.
2. They open a chat with their new bot and press **Start** (or send it any message). The bot can't message them
   until they've done this.
3. Find their chat id (replace `<BOT_TOKEN>`):

   ```bash
   curl -s "https://api.telegram.org/bot<BOT_TOKEN>/getUpdates"
   ```

   The number at `result[0].message.chat.id` is the chat id. If `result` is empty, they haven't messaged the bot yet.
4. Store both:

   ```bash
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   ```

   ```bash
   npx wrangler secret put TELEGRAM_CHAT_ID
   ```

5. Send a test message:

   ```bash
   node -e 'const c=require("./.mcp-local.json");fetch(c.MCP_BASE+"/healthcheck?notify=test",{headers:{"x-mcp-key":c.MCP_ADMIN_KEY}}).then(r=>r.text()).then(console.log)'
   ```

   It should print `{"telegramTestSent":true}`, and the message should arrive.

When an alert comes in later, the fix is usually one of two things. If it says the token is expiring or `[auth]`,
repeat step 8 with a fresh cookie. Anything else means Skool changed something: paste the alert into a Claude Code
session in this folder and say "fix this" (the fix path is in [NOTES.md](NOTES.md) → Maintenance).

### Step 10: Run the first health check

Course progress is normally collected overnight. Run it once now so the health check has something to check:

```bash
node -e 'const c=require("./.mcp-local.json");fetch(c.MCP_BASE+"/course-progress?step=1",{headers:{"x-mcp-key":c.MCP_ADMIN_KEY}}).then(r=>r.json()).then(console.log)'
```

Repeat until it shows `phase: "done"` (two runs for about 50 members; each run handles about 45). Then:

```bash
node -e 'const c=require("./.mcp-local.json");fetch(c.MCP_BASE+"/healthcheck",{headers:{"x-mcp-key":c.MCP_ADMIN_KEY}}).then(r=>r.json()).then(d=>{console.log("ok:",d.ok);for(const p of d.profiles)for(const k of p.checks)console.log(k.ok?"  ok  ":"  FAIL",k.name,"-",k.detail)})'
```

Every line should say `ok`. Checks that don't apply (for example the classroom, if the community has no courses) say
`ok (skipped: ...)`.

### Step 11: Add it to Claude

The person does this in Claude (on the web it is <https://claude.ai> → Settings → Connectors):

1. **Add custom connector**. Name: `Skool`. URL: the connector URL from step 7. Authentication: none.
2. Save, then open the connector's tool settings. Let **read** tools run without asking, and keep every **write** tool
   (create, delete, send, approve, like, edit, publish) on **needs approval**.
3. In a new chat with the connector turned on, ask: *"Use skool_whoami."* Claude should list their communities.

Add it in Claude's Connectors settings, **not** with `claude mcp add`. The server only accepts calls that come from
Anthropic's servers. A connector added in Claude's settings follows the person's account into Claude Code, but one
added locally with `claude mcp add` calls from their own computer, and the server will refuse it.

Why the key goes in the URL: the connector form on Claude web and mobile has no field for custom headers, so a URL is
the only thing every Claude app can carry. If the key were required as a header, Claude would show *"Couldn't register
with Skool's sign-in service"*. That error means the key is missing, not that anything is wrong with OAuth.

### Step 12: Start your verification log

Open `VERIFICATION.md` and record what you tested and when: the health check result, `skool_whoami` in Claude, and
anything else you try. That log is how future sessions (yours or an agent's) know what is proven and what is assumed.

Done. A good first real request in Claude: *"What happened in my Skool community this week?"*

---

## Using it

- In any chat, ask Claude to run **`skool_usage_guide`** before doing anything unusual. It covers every capability
  and the traps (for example, a comment with no text is almost always a GIF, not an error).
- Claude will show you the exact text and ask before any post, comment, like, poll or DM. Writes can't really be
  undone: deleting a post does not take back the notification Skool already sent, and DMs can't be deleted at all.
- For the complete tool list and how each one works, see [NOTES.md](NOTES.md).

## Adding another Skool account

For example, so Claude can also post as a co-host:

1. In `wrangler.toml`, list both, admin first. A short description after the colon tells Claude who each one is:
   `SKOOL_PROFILES = "main:My admin account, cohost:My co-host's account"`
2. Store the second account's cookie (copied the same way as in step 8, while logged in as that account):
   `npx wrangler secret put SKOOL_TOKEN_COHOST`. The secret name is `SKOOL_TOKEN_` plus the name in capitals.
3. `npx wrangler deploy`. In Claude, turn the connector off and on again so it picks up the new account.

Reads use the first account unless told otherwise; writes always ask which account to use. The daily health check
covers every account that has a cookie stored. With three accounts it uses most of the free plan's per-run request
allowance, so three is the practical maximum on the free plan.

## Getting updates from the template

New tools and fixes land in the template from time to time. To bring them into your copy:

```bash
git fetch upstream
git merge upstream/main
npm ci
npm run typecheck
npx wrangler deploy
```

Your own settings live only in `wrangler.toml` and in Cloudflare secrets, so updates rarely collide with them. If git
reports a conflict in `wrangler.toml`, keep your own values and take any new settings from the template. Then re-run
the health check (step 10) and add a line to `VERIFICATION.md`.

## Test from your machine (optional)

The test scripts in `scripts/` talk to your deployed server the same way Claude does, using `.mcp-local.json`. The
server refuses them by default, because they don't come from Anthropic, so open it up while testing and close it
straight after:

```bash
echo 1 | npx wrangler secret put MCP_ALLOW_ANY_IP
```

```bash
npm run smoke
```

```bash
echo y | npx wrangler secret delete MCP_ALLOW_ANY_IP
```

`npm run smoke` lists the tools and runs every read tool once. `node scripts/comments-test.mjs` checks comment paging
on a large public post (read-only). `node scripts/write-test.mjs main <labelId>` creates a test post and comment and
deletes them again, but members may still get a notification, so ask first. Confirm the toggle is gone afterwards with
`npx wrangler secret list`.

**Test changes before deploying.** To try changed code without touching the live server, bundle it
(`npx esbuild src/index.ts --bundle --platform=node --format=esm --outfile=/tmp/worker.mjs`) and serve it with a small
Node script. The script imports the bundle, calls its default export's `fetch(request, env, ctx)` with your secrets
and `MCP_ALLOW_ANY_IP: "1"` in its own `env` object, and listens on `127.0.0.1`. Then set `"MCP_BASE"` in
`.mcp-local.json` (or the `MCP_BASE` environment variable) to that local address and run the scripts. Go easy:
hundreds of requests in a few minutes can get your IP briefly blocked by Skool's firewall, which shows up as `[edge]`
errors.

## Looking after it

- **Login expiry**: about a year after the cookie was copied. The alert arrives 30 days ahead; repeat step 8. No
  redeploy needed.
- **Changing the secret URL** (if it leaked): put new values for `MCP_PATH_SECRET` and/or `MCP_ADMIN_KEY` (step 7),
  then update the connector URL in Claude. Old URLs stop working immediately.
- **Something broke**: see [NOTES.md](NOTES.md) → Maintenance.
- **A new tool doesn't show up in Claude**: the connector's tool list is cached. Turn the connector off and on, or
  remove and re-add it.

## Costs and limits

Everything here fits Cloudflare's free plan: one Worker, one cron trigger, and a KV store using a few writes a night.
The main limit is 50 outgoing requests per call, so a few tools page their results (long video transcripts come in
roughly 22-minute pieces in chat; from Claude Code, the usage guide has a one-shot shortcut).

## Files

| | |
|---|---|
| `src/` | The server. `skool.ts` holds every Skool endpoint, `tools.ts` the tools and the usage guide, `healthcheck.ts` the daily check |
| `wrangler.toml` | Your community and accounts. The only file you edit |
| `scripts/` | Test scripts, the group-id finder, and the endpoint inventory refresher |
| `NOTES.md` | How everything works and what Skool's traps are. Read before changing code |
| `SKOOL-ENDPOINTS.md` | Every endpoint Skool's own website calls, so "can Skool do X?" is a lookup |
| `VERIFICATION.md` | Your log of what you tested |

## Credits

Built and maintained by [The Essence Community](https://github.com/TheEssenceCommunity). Endpoint research builds on
[louiewoof2026/skool-mcp](https://github.com/louiewoof2026/skool-mcp),
[Solnest-AI/skool-mcp-community](https://github.com/Solnest-AI/skool-mcp-community) and
[elchamoluso/skool-mcp-kit](https://github.com/elchamoluso/skool-mcp-kit). MIT licensed; see [LICENSE](LICENSE).
