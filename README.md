# Year 7 Class Role Bot

A Discord bot that asks for your school email, checks it against the class roster
(`db.csv`) and — if it matches — gives you the Discord role for your class (7A–7R).

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

No privileged intents are needed (the bot only reads interactions), so leave
**Presence/Members/Message Content** intents off.

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
   View Channel, Send Messages, Read Message History, **Manage Roles**).
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

The roster is re-read from disk on every verification, so adding or fixing a student in
the CSV takes effect immediately — no restart needed. Rows without a usable email
(for example the `UNKNOWN` placeholder row) are skipped automatically, and students in a
class with no configured role get a clear "ask an admin" message.

## Scripts

```
npm install       # dependencies
npm run dev       # run the bot (node src/bot.ts)
npm test          # roster + verification tests (node --test) against the real CSV
npm run typecheck # tsc --noEmit
```

## Data storage (Redis)

Verification data lives in Redis — `redis://red-db2m8kvavr4c73ejq3g0:6379` by default,
overridable with the `REDIS_URL` environment variable:

| Key | Value |
| --- | --- |
| `classbot:verify:email:<email>` | JSON record `{userId, userTag, email, className, verifiedAt}` |
| `classbot:verify:user:<userId>` | the email that user claimed (reverse index for review) |

Claims are permanent and conflict-free by construction (`SET NX`): a second user submitting
the same address is told a user already used it and that manual review may be required. The
bot reconnects every 15 s if Redis is down and reports its status on the health endpoint.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Health endpoint says `DISCORD_BOT_TOKEN is not set` | Add the key in Settings → Environment, then `freebuff-preview restart`. |
| Health endpoint says `"redis":"error"` (e.g. `ENOTFOUND`) | The bot can't resolve/reach the Redis host from where it runs. Point `REDIS_URL` at a Redis instance reachable from this workspace, then restart the preview. |
| "I don't have permission to manage roles" (API 50013) | Move the bot's role above 7A–7R and make sure it has Manage Roles. |
| `/verify` not listed | Wait for global command propagation (up to an hour) or re-invite; the bot re-registers on every start. |
| "couldn't find ... on the class list" | Check the address against the roster CSV — matching is case-insensitive, domain included. |
