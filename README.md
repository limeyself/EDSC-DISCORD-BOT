# Year 7 Class Role Bot

A Discord bot that asks for your school email, checks it against the class roster
(`the final data(Sheet1).csv`) and — if it matches — gives you the Discord role for
your class (7A–7R).

## How it works

1. A student runs `/verify` in the server.
2. The bot opens a **private modal** asking for their school email — nothing is posted in chat.
3. The email is normalized (lower-cased, spaces stripped) and looked up in the roster CSV.
4. On a match the bot removes any other class role and adds the role for that student's class.
5. The reply is ephemeral, so only that student sees the result. Emails are never logged.

## Setup

### 1. Create the bot and add the token

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**.
2. **Bot** → **Reset Token** → copy it.
3. In Freebuff: **Settings → Environment** → add the key `DISCORD_BOT_TOKEN` with that token value.

No privileged intents are needed (the bot only reads interactions), so leave
**Presence/Members/Message Content** intents off.

### 2. Start the bot

The preview commands are already saved (`bun install`, `bun run dev` on port 3000).
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
| Student roster | `the final data(Sheet1).csv` (columns: First Name, Last Name, Gender, Class, Email Address, School, Year) |
| Roster path override | `ROSTER_CSV` env var |

The roster is re-read from disk on every verification, so adding or fixing a student in
the CSV takes effect immediately — no restart needed. Rows without a usable email
(for example the `UNKNOWN` placeholder row) are skipped automatically, and students in a
class with no configured role get a clear "ask an admin" message.

## Scripts

```
bun install       # dependencies
bun run dev       # run the bot
bun test          # roster + verification tests against the real CSV
bun run typecheck # tsc --noEmit
```

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Health endpoint says `DISCORD_BOT_TOKEN is not set` | Add the key in Settings → Environment, then `freebuff-preview restart`. |
| "I don't have permission to manage roles" (API 50013) | Move the bot's role above 7A–7R and make sure it has Manage Roles. |
| `/verify` not listed | Wait for global command propagation (up to an hour) or re-invite; the bot re-registers on every start. |
| "couldn't find ... on the class list" | Check the address against the roster CSV — matching is case-insensitive, domain included. |
