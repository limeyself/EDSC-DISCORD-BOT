# Year 7 Class Role Bot

A Discord bot that asks for your school email, checks it against the class roster
(`db.csv`) and — if it matches — gives you the Discord role for your class (7A–7R).
It also runs a **counting channel** game: members post 1, 2, 3 … in order and a
wrong number resets the count (the record survives).

Runs on **Node.js ≥ 22.18** (TypeScript is executed natively via built-in type
stripping — no bundler or transpiler involved).

## How it works

1. A student runs `/verify` in the server.
2. The bot opens a **private modal** asking for their school email — nothing is posted in chat.
3. The email is normalized (lower-cased, spaces stripped) and looked up in the roster CSV.
4. The Redis registry is checked: if another Discord user already claimed that address — or the
   roster has no data for it — the bot replies that a user has already used it and a manual
   review may be required, and grants nothing.
5. On a free address the bot claims it in Redis, removes any other class role and adds the role
   for that student's class (the claim is rolled back if the role grant fails).
6. The reply is ephemeral, so only that student sees the result. Emails are never logged to the
   console — they exist only in Redis as the claim registry.

## Setup

### 1. Create the bot and add the token

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**.
2. **Bot** → **Reset Token** → copy it.
3. In Freebuff: **Settings → Environment** → add the key `DISCORD_BOT_TOKEN` with that token value.

The counting feature reads chat messages, so the **Message Content Intent** must
be toggled **on** under **Bot → Privileged Gateway Intents** (unverified bots can
just flip the switch — no review needed). Without it Discord refuses the gateway
with close code **4014**; if you can't enable it, add
`DISABLE_MESSAGE_CONTENT_INTENT=1` in Settings → Environment instead — the bot
boots and `/verify` works, but counting stays inert. **Presence** and **Server
Members** intents stay off.

### 2. Start the bot

The preview commands are already saved (`npm install`, `npm run dev` on port 3000).
Start the preview and read the logs:

```
freebuff-preview start
freebuff-preview logs
```

On startup the bot prints its **invite URL** and registers `/verify` in every server it
is already in (those appear instantly; the global registration can take up to an hour).

### 3. Invite it and fix the role order

1. Open the invite URL from the logs and authorise the bot (permissions are pre-filled:
   View Channel, Send Messages, Read Message History, **Manage Messages**, **Manage Roles**).
2. **Server Settings → Roles**: drag the bot's role **above every class role (7A–7R)**.
   Discord will not let a bot edit roles that sit above its own highest role.

### 4. Verify

Run `/verify`, type the school email, and the class role is applied.

## Configuration

| What | Where |
| --- | --- |
| Class → role ID mapping (7A–7R) | `src/roles.ts` |
| Student roster | `db.csv` (columns: First Name, Last Name, Gender, Class, Email Address, School, Year) |
| Roster path override | `ROSTER_CSV` env var |
| Claim registry | Redis at `redis://red-db2m8kvavr4c73ejq3g0:6379` (override: `REDIS_URL` env var) |
| Verification panel access token (optional) | `PANEL_TOKEN` env var — when set, `/panel` requires `?token=<value>` |

The roster is re-read from disk on every verification, so adding or fixing a student in
the CSV takes effect immediately — no restart needed. Rows without a usable email
(for example the `UNKNOWN` placeholder row) are skipped automatically, and students in a
class with no configured role get a clear "ask an admin" message.

## Scripts

```
npm install       # dependencies
npm run dev       # run the bot (node src/bot.ts)
npm test          # roster, verification and counting tests (node --test) against the real CSV
npm run typecheck # tsc --noEmit
```

## Data storage (Redis)

Verification data lives in Redis — `redis://red-db2m8kvavr4c73ejq3g0:6379` by default,
overridable with the `REDIS_URL` environment variable:

| Key | Value |
| --- | --- |
| `classbot:verify:email:<email>` | JSON record `{userId, userTag, email, className, verifiedAt}` |
| `classbot:verify:user:<userId>` | the email that user claimed (reverse index for review) |
| `classbot:counting:channel:<guildId>` | the guild's counting channel ID |
| `classbot:counting:state:<guildId>` | JSON `{count, record}` — current count and record |

Claims are permanent and conflict-free by construction (`SET NX`): a second user submitting
the same address is told a user already used it and that manual review may be required. The
bot reconnects every 15 s if Redis is down and reports its status on the health endpoint.

## Verification panel

The bot serves an admin panel at **`/panel`** on the same port as the health
endpoint (the preview URL, or `http://localhost:3000/panel`). It shows:

- status pills for the Discord gateway and Redis,
- totals: verified students, classes represented, roster size, uptime,
- one row per claim — Discord user, claimed email, class, and verification time
  (Melbourne local time), newest first,
- an amber banner with the underlying error if the Redis registry cannot be read
  (the page never pretends the registry is empty when the store is down).

The page auto-refreshes every 15 seconds. Every other path (including `/`)
still returns the health JSON used for preview readiness.

Because the panel lists student emails, set `PANEL_TOKEN` in Settings →
Environment to require a `?token=` query parameter (`/panel?token=…`);
requests without it get a plain 404. Without the token the panel is open to
anyone with the preview URL.

## Counting channel

Members count up together in one channel: **1, 2, 3 …**

| Command | Who | What it does |
| --- | --- | --- |
| `/counting setup channel:#counting` | Manage Server | Picks the channel where members count. |
| `/counting status` | anyone | Shows the current count, the next number and the record (ephemeral). |
| `/counting reset` | Manage Server | Starts over at 1 — the record is kept. |

Rules the bot enforces:

- The next message must be exactly the next number — digits only, nothing else.
- A **wrong number** resets the count to 1: the bot deletes the message (needs
  the Manage Messages permission) and posts what it expected. The record stands.
- Ordinary chat is ignored rather than punished, so conversation doesn't reset
  the count; bots (including this one) never count.
- The **record** is the highest number reached before any reset and survives
  both mistakes and `/counting reset`.
- Progress is written through to Redis (`classbot:counting:*`) so restarts don't
  lose it. If Redis is unreachable the count keeps working in memory for the
  session (a warning appears in `/counting setup`), and syncing resumes when the
  store is back.

Counting needs the **Message Content Intent** (see Setup step 1). Give the bot
View Channel + Send Messages + Read Message History in that channel; Manage
Messages lets it delete wrong numbers.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Health endpoint says `DISCORD_BOT_TOKEN is not set` | Add the key in Settings → Environment, then `freebuff-preview restart`. |
| Health endpoint says `"redis":"error"` (e.g. `ENOTFOUND`) | The bot can't resolve/reach the Redis host from where it runs. Point `REDIS_URL` at a Redis instance reachable from this workspace, then restart the preview. |
| Panel shows "Could not read the verification store" | Same cause as above — the registry lives in Redis. Fix connectivity and reload `/panel`. |
| `/panel` returns 404 while `/` returns health JSON | A `PANEL_TOKEN` is set. Open `/panel?token=<value>` instead. |
| "I don't have permission to manage roles" (API 50013) | Move the bot's role above 7A–7R and make sure it has Manage Roles. |
| Gateway fails with 4014 "Disallowed intent(s)" | Enable the Message Content Intent in the Developer Portal, or set `DISABLE_MESSAGE_CONTENT_INTENT=1` to run without counting. |
| Counting channel: nothing happens / logs say messages arrive with empty content | The Message Content Intent is off in the portal. Enable it and `freebuff-preview restart`. |
| Counting resets after every restart | Redis is unreachable (`"redis":"error"`), so the count only lives in memory. Fix `REDIS_URL` connectivity to persist it. |
| `/verify` not listed | Wait for global command propagation (up to an hour) or re-invite; the bot re-registers on every start. |
| "couldn't find ... on the class list" | Check the address against the roster CSV — matching is case-insensitive, domain included. |
