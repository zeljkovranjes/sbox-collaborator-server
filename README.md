<p align="center"><img src="web/public/logo.svg" width="96" alt=""></p>

# s&box Collaborator – MCP collaboration server

A self-hosted MCP server that makes the coding agents of a small s&box team (Claude Code, Codex
CLI, Cursor, OpenCode, anything MCP) behave like members of the same team. It keeps structured
shared state – presence, tasks, file and asset reservations, change announcements, decisions,
knowledge, messages, build status – and ties it to your GitHub repositories. GitHub stays the
source of truth; the server coordinates the agents around it.

Pairs with the **collaborator** s&box editor library (`01_Libraries/collaborator`), which shows
the team inside the editor, reserves assets from the asset browser and uploads the real engine
asset dependency graph.

## Features

- **Projects** – multiple s&box games/libraries: repos, package ident, architecture summary,
  conventions, milestone, important directories.
- **Presence** – every agent registers (client, model, machine, branch, files, status) with
  heartbeats; offline detection.
- **Task board** – atomic claiming (no silent double claims), blocking, release, completion,
  dependencies, GitHub issue/PR links, stale-owner takeover with notification.
- **File & asset reservations** – files and directories, advisory, conflict warnings naming the
  owner and task, expiry, automatic release when agents disappear.
- **s&box asset awareness** – `.vmdl`, `.vmat`, `.vtex`, `.shader`, `.sound`, `.scene`,
  `.prefab`, `.animgraph`, source models, textures, audio… with dependency/reference trees.
- **GitHub** – webhooks for pushes, branches, PRs, reviews, merges, issues, correlated with
  developers, agents, tasks and reserved files; API access for commits, diffs, issues, PRs.
- **Change announcements** – files, APIs added/removed/renamed, behavior and breaking changes,
  tests, known issues, follow-ups – automatically in teammates' next context sync.
- **Decisions, knowledge, messages, build/test events, activity feed.**
- **`project_sync_context`** – one compact, relevance-ranked, time-compacted packet to start work.
- **Team notices** – tool results carry short nudges (unread blockers, breaking changes, broken
  builds) so agents notice without polling or chatting.
- **Dashboard** – live (SSE) overview of who is online and doing what, reservations, commits,
  blockers, tasks, assets, decisions, knowledge, messages.
- **Auth** – join with *server address → server key → GitHub login*; per-device access keys
  with scopes (read-only), project limits and revocation; nothing sensitive stored in plaintext.

## Quick start

```sh
cp .env.example .env              # fill in, see docs/deployment.md
docker compose --profile caddy up -d --build
```

Then open `https://your-domain`, sign in with GitHub, create a project and invite your teammate.

Local, without Docker (SQLite):

```sh
npm install
SECRET_KEY=$(openssl rand -hex 32) ADMIN_GITHUB_LOGINS=you npm run dev
```

## Documentation

| | |
|---|---|
| [docs/deployment.md](docs/deployment.md) | Docker, HTTPS, reverse proxy, first admin, backups, upgrades |
| [docs/configuration.md](docs/configuration.md) | environment variables |
| [docs/github-webhooks.md](docs/github-webhooks.md) | webhook setup and what it does |
| [docs/mcp-tools.md](docs/mcp-tools.md) | all 60 MCP tools |
| [docs/http-api.md](docs/http-api.md) | HTTP API, device sign-in, realtime events |
| [docs/developer-workflow.md](docs/developer-workflow.md) | how the team and agents work with it |
| [docs/security.md](docs/security.md) | credentials, permissions, hardening |
| [docs/database.md](docs/database.md) | schema, migrations, concurrency |
| [clients/](clients) | Claude Code, Codex, Cursor, OpenCode configs and the agent instruction file |

## Development

```sh
npm run dev         # API + MCP on :8080 (tsx watch)
npm run dev:web     # dashboard on :5173 with proxy
npm test            # vitest – SQLite and PostgreSQL (PGlite)
npm run typecheck
npm run build       # dist/src (server) + dist/web (dashboard)
```

Layout: `src/services` (domain logic), `src/tools` (MCP tool definitions, shared with
`POST /api/tools/<name>`), `src/mcp` (Streamable HTTP transport), `src/http` (API, auth, SSE,
webhooks), `src/db` (schema, migrations), `web/` (Preact dashboard), `test/`.

## License

MIT
