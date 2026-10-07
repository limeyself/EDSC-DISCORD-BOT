# Year 7 Class Role Bot

A Discord bot that asks for your school email, checks it against the class roster
(`db.csv`) and — once an **admin approves the request manually** — gives you the
Discord role for your class (7A–7R) in the main server and DMs you the invite to
your **class's own server**. Each class has one server slot, and admin commands
are gated by a single role instead of permission bits. It also runs a
**counting channel** game: members post 1, 2, 3 … in order and a wrong number
resets the count (the record survives).

Runs on **Node.js ≥ 22.18** (TypeScript is executed natively via built-in type
stripping — no bundler or transpiler involved).

## How it works

1. A student of a class with no server yet runs `/request` in the **main server**:
   the modal collects the **class server's ID**, an optional **invite link**, and
   their **school email** (which proves which class they belong to — they can only
   ever request their own class's server).
2. An admin approves with `/server-request approve user:@student`, which binds
   the class to that server (or denies with `/server-request deny`). The student
   then invites the bot to that server using the link in the admin reply.
3. A student runs `/verify` in the **main server** and submits their school email
   in a **private modal** — nothing is posted in chat.
3. The email is normalized and looked up in the roster CSV. The request is refused
   (with a clear reason) if the roster has no data for it, another user already
   claimed it, the student already has a review in flight, someone else holds their
   class's **server slot**, the class has no registered server, or the bot hasn't
   been invited there yet.
4. Otherwise the bot **claims the class's server slot** and parks a pending review —
   nothing is granted automatically.
5. An admin runs `/review list`, then `/review approve user:@student` (or
   `/review deny`). Approval claims the email (`SET NX`), grants the class role in
   the main server, and DMs the student an invite link to their class server.
   Denial frees the slot and DMs the student the reason.
6. The slot stays held after approval until an admin runs
   `/review release class:7A` — one verified student per class at a time.
   Re-running `/verify` after approval just re-grants the role instantly.

All replies are ephemeral. Emails are never logged to the console — they exist
only in Redis as the claim registry.

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

### 4. Grant the admin role

Create (or pick) a role with ID **`1557298773951123476`** and give it to the
people who run reviews. Every admin command — `/review …`, `/class-server …`,
`/counting setup`, `/counting reset` — checks for this role instead of Discord
permission bits, so it replaces all previous permission requirements.

### 5. Verify

Run `/verify`, type the school email, wait for an admin's `/review approve`, and
the class role plus the class-server invite arrive by DM.

## Adding a class server (student /request → admin /server-request)

Students get their class's server linked without touching admin commands:

| Command | Who | What it does |
| --- | --- | --- |
| `/request` | student | Opens a private modal: class server ID, optional invite link, school email (identity + class proof). |
| `/server-request list` | admin role | Open requests: student, class, server ID, invite, request time (Melbourne). |
| `/server-request approve user:@student` | admin role | Binds that class to the submitted server, clears the request, DMs the student; reply shows the bot-invite link for the class server. |
| `/server-request deny user:@student [reason]` | admin role | Removes the request and DMs the student. |

Rules: the class is derived from the submitted roster email, so students can
only request **their own class**; a student can have only **one** open request;
and a class that already has a server can't receive another (admins change that
via `/class-server clear` instead). Admins can still bind servers directly with
`/class-server set` at any time.

## Manual review & class servers

| Command | Who | What it does |
| --- | --- | --- |
| `/class-server set class:7A server:<id> [invite:<url>]` | admin role | Binds a class to a Discord server. Runs from any server — only the target's ID is needed. Warns if the bot isn't in that server yet. |
| `/class-server clear class:7A` | admin role | Removes the binding (reviews for that class are blocked). |
| `/class-server list` | admin role | All bindings: server ID, whether the bot is present, who holds each slot. |
| `/review list` | admin role | Pending requests: student, class, email, request time (Melbourne). |
| `/review approve user:@student` | admin role | Grants the class role in the main server, DMs the class-server invite, keeps the slot held. Rolls the email claim back if the role grant fails. |
| `/review deny user:@student [reason]` | admin role | Removes the request, frees the slot, DMs the student. |
| `/review release class:7A` | admin role | Frees a held slot so the next student of that class can request a review. |

Rules:

- Verification always happens in the **main server**; the class servers are only
  joined after approval (the invite comes by DM).
- One **slot per class**: a review claims it, approval keeps it, denial or
  `/review release` frees it. The bot won't accept a second request for a class
  while its slot is held.
- The bot must be **invited to the class server before** the review is requested,
  and the class must be registered with `/class-server set` first.
- The invite DM uses the stored `invite:` link if present; otherwise the bot
  creates a fresh invite on approval (the class server needs **Create Instant
  Invite** for that). If the student has DMs closed, the invite is shown to the
  approving admin instead.
- A student can never be pending twice or hold two servers — their claim binds
  them to their own class's server only.

## Configuration

| What | Where |
| --- | --- |
| Class → role ID mapping (7A–7R) | `src/roles.ts` |
| Admin role (gates every admin command) | `ADMIN_ROLE_ID` in `src/roles.ts` (`1557298773951123476`) |
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
| `classbot:verify:pending:<userId>` | JSON pending review `{userId, userTag, email, className, guildId, requestedAt}` |
| `classbot:verify:slot:<className>` | the userId holding that class's server slot (`SET NX`) |
| `classbot:classserver:<className>` | JSON `{guildId, invite, setAt}` — the class's registered server |
| `classbot:verify:pending:req:<userId>` | JSON server request `{userId, userTag, className, serverId, invite, requestedAt}` |

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
| `/counting setup channel:#counting` | admin role | Picks the channel where members count. |
| `/counting status` | anyone | Shows the current count, the next number and the record (ephemeral). |
| `/counting reset` | admin role | Starts over at 1 — the record is kept. |

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
| "you need the 1557298773951123476 role" | Give your admin role that ID (or change `ADMIN_ROLE_ID` in `src/roles.ts`), then restart. |
| "Someone already holds the … server slot" | The class already has a student in review/approved — run `/review release class:<name>` to free it. |
| "I don't have a server registered for …" / "I'm not in the … server" | Run `/class-server set` with the class server's ID and invite the bot to that server, then retry `/verify`. |
| Approval says "couldn't DM them" | The student has DMs closed — relay the invite shown in the admin reply manually. |
| "**7B** already has a server bound to it" (on /request or approve) | That class already has a server. An admin can `/class-server clear class:7B` first if it genuinely needs to change. |
| "Your request for **7B** … is already waiting" | The student already has an open server request — wait for an admin's `/server-request approve` or `deny`. |
