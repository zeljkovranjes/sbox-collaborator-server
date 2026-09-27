# Database

PostgreSQL in production; SQLite (built into Node, `node:sqlite`) for local testing. The schema is
written with Kysely's schema builder so the same migration runs on both
([src/db/migrations](../src/db/migrations)); migrations run automatically on start and are
tracked in `kysely_migration`.

Portable conventions: timestamps are epoch milliseconds (`bigint`), booleans are `0/1`, lists are
JSON text. No asset binaries are stored – only paths, types, relationships and metadata.

| table | holds |
|---|---|
| `developers` | people (GitHub login, role, project access) |
| `access_keys` | per-device keys (hashed), scopes, project limits, revocation |
| `join_keys` | server keys for inviting teammates (hashed, uses, expiry, bound login) |
| `web_sessions` | dashboard sessions (hashed) |
| `device_auths` | pending editor sign-ins |
| `projects`, `project_repos` | projects, context, linked GitHub repositories |
| `agents` | agent sessions: client, model, machine, status, task, branch, files, heartbeat |
| `tasks` | the task board (atomic claims, `version` for optimistic concurrency) |
| `reservations` | advisory file/directory reservations with expiry |
| `assets`, `asset_links` | s&box asset metadata and the dependency graph |
| `commits`, `branches`, `pull_requests`, `issues`, `webhook_deliveries` | GitHub state from webhooks/API |
| `changes` | structured change announcements |
| `decisions` | decision log (supersede chain) |
| `messages`, `message_receipts` | agent messages and per-developer read/ack state |
| `knowledge` | durable project / global knowledge |
| `test_runs` | build and playtest results |
| `activity` | the chronological feed (with importance 0–3) |

## Concurrency

- Task claims are a single conditional `UPDATE … WHERE status IN (…) RETURNING`, so exactly one
  concurrent claim wins; other task writes use a `version` check.
- Reservations are created under a per-project lock (in-process mutex plus
  `pg_advisory_xact_lock` on PostgreSQL) so overlapping reservations cannot race.
- On SQLite the connection is handed out one caller at a time (single writer).

Tests run every storage suite on SQLite and on PostgreSQL (PGlite).
