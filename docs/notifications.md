# Discord notifications and weekly digests

## Discord

The server pings a Discord channel for the things that need a person, not the whole feed:

| ping | when |
|---|---|
| 🛑 blocker | a task is marked blocked |
| ❌ build failed | a build or test fails (including the s&box editor's automatic compile/playtest results) |
| ⚠️ conflict | someone pushed changes to files another developer has reserved |
| 💥 breaking change | a completed change removes or renames APIs, or lists breaking changes |
| 🤝 handoff | a task is handed off (the recipient is @mentioned) |
| 💬 message | a question, request, warning, blocker or handoff message sent to a person (@mentioned) |
| 🗒️ digest | the weekly digest |

Identical pings within 10 minutes are sent once (a flapping build does not spam the channel).

**Set up:** in Discord, *Channel settings ▸ Integrations ▸ Webhooks ▸ New webhook ▸ Copy URL*.
Then either

- per project: dashboard *Project ▸ Discord notifications* (stored encrypted with `SECRET_KEY`,
  never shown again), or
- for every project: `DISCORD_WEBHOOK_URL` in `.env`.

**Mentions:** each developer sets their Discord user id under *Connect agents & keys ▸ Your
account* (Discord ▸ Settings ▸ Advanced ▸ Developer Mode, then right-click your name ▸ Copy User ID).

## Weekly digest

Every week (default Monday 09:00 server time) the server writes a digest per project: what
shipped, breaking/API changes, what is in progress or blocked, commits per person, decisions and
knowledge, failing builds. It appears on the dashboard's Activity page, is posted to Discord, and
agents can ask for any period with `team_digest`.

| variable | default | |
|---|---|---|
| `DIGEST_WEEKDAY` | `1` | 0 Sunday … 6 Saturday; `-1` turns digests off |
| `DIGEST_HOUR` | `9` | local server hour (set `TZ` in the container for your timezone) |

## Catch me up

`team_catch_up` (dashboard: the "While you were away" card; s&box editor: ⋯ ▸ Catch me up) gives
each developer a personal summary since they last looked: teammates' breaking changes, finished
work, what is in progress or blocked, commits, decisions, failing builds, and what needs them
(handoffs to them, unread messages). Your own work is left out.
