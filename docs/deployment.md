# Deployment

The server is one Node.js process plus PostgreSQL. Docker Compose runs both. Put it behind HTTPS:
access keys are bearer tokens and must never travel over plain HTTP.

Example host: `mcp.chomnr.com`, a small Linux VPS (1 vCPU / 1 GB RAM is plenty for a team).

## 1. Get the code and configure

```sh
git clone <this repo> /opt/collaborator && cd /opt/collaborator
cp .env.example .env
openssl rand -hex 32   # → SECRET_KEY
openssl rand -hex 24   # → POSTGRES_PASSWORD
openssl rand -hex 20   # → GITHUB_WEBHOOK_SECRET
nano .env              # PUBLIC_URL, COLLAB_DOMAIN, ADMIN_GITHUB_LOGINS, GitHub values
chmod 600 .env
```

## 2. GitHub OAuth app (sign-in)

GitHub → Settings → Developer settings → **OAuth Apps → New OAuth App**

| field | value |
|---|---|
| Homepage URL | `https://mcp.chomnr.com` |
| Authorization callback URL | `https://mcp.chomnr.com/auth/github/callback` |

Copy the client id and a generated client secret into `GITHUB_OAUTH_CLIENT_ID` /
`GITHUB_OAUTH_CLIENT_SECRET`. The server only requests `read:user`, uses the OAuth token once to
learn who signed in, and never stores it.

## 3. GitHub API token (commits, PRs, issues)

Create a **fine-grained personal access token** limited to your game/library repositories:
Contents *read*, Metadata *read*, Pull requests *read*, Issues *read & write*. Put it in
`GITHUB_TOKEN` (or `GITHUB_TOKEN_FILE` pointing at a Docker secret). It lives only in the
environment, never in the database.

## 4. Start

**With automatic HTTPS (Caddy, easiest):** point the domain's DNS A/AAAA record at the server,
open ports 80 and 443, then

```sh
docker compose --profile caddy up -d --build
```

Caddy obtains and renews Let's Encrypt certificates on its own ([deploy/Caddyfile](../deploy/Caddyfile)).

**With your own reverse proxy:** `docker compose up -d --build` exposes the server on
`127.0.0.1:8080` only. Use [deploy/nginx.conf](../deploy/nginx.conf) (with certbot) or any proxy
that forwards `X-Forwarded-*` headers and **does not buffer** responses (SSE and MCP stream).

Check: `curl https://mcp.chomnr.com/healthz` → `{"ok":true,"db":true,…}`.

## 5. First admin, first project, invite your friend

1. Open `https://mcp.chomnr.com`, choose **I already have an account → Continue with GitHub**.
   Logins listed in `ADMIN_GITHUB_LOGINS` become admins on first sign-in.
2. **Server admin → Project**: create the project (e.g. `sailing`, repo `you/sailing`).
3. **Server admin → Invite teammate**: enter your friend's GitHub login. You get a single-use
   **server key** (`sbj_…`). Send it privately with the server address.
4. Your friend opens the **Collaborator** panel in the s&box editor (or the website), enters the
   address, the server key, then signs in with GitHub. Their editor receives its own access key.
5. Each of you creates access keys for your coding agents under **Connect agents & keys**
   ([clients/README.md](../clients/README.md)).

Without Docker/GitHub you can do the same from the CLI:

```sh
docker compose exec server node dist/src/cli.js server-key create --name "for alex" --github alexgh
docker compose exec server node dist/src/cli.js key create chomnr --name "desk claude-code"
docker compose exec server node dist/src/cli.js project create sailing --name Sailing --kind game --repo you/sailing
```

### Making someone an admin later

Dashboard: **Server admin ▸ Developers ▸ Make admin** (and *Make member* to undo). Or from the
server: `docker compose exec server node dist/src/cli.js developer role <id> admin`.

## 6. GitHub webhooks

See [github-webhooks.md](github-webhooks.md).

## Backups

Everything important is in PostgreSQL (assets stay in Git/LFS; only metadata is stored).

```sh
./scripts/backup.sh                                  # writes backups/collab_<date>.dump
crontab -e   # 15 3 * * * cd /opt/collaborator && ./scripts/backup.sh >> backups/backup.log 2>&1
./scripts/restore.sh backups/collab_2026-09-26_0315.dump
```

Copy `backups/` off the machine (restic, rclone, …). Also keep a copy of `.env` somewhere safe –
without `SECRET_KEY` every access key, session and server key becomes invalid.

## Upgrades

```sh
git pull && docker compose up -d --build
```

Database migrations run automatically on start.

## Health and logs

- `GET /healthz` – database ping, version, uptime, open MCP sessions (used by the Docker healthcheck).
- `docker compose logs -f server` – JSON log lines.
- **Server admin** in the dashboard shows which integrations are configured.

## Local development

```sh
npm install
SECRET_KEY=$(openssl rand -hex 32) npm run dev      # SQLite in ./data, http://localhost:8080
npm run dev:web                                    # dashboard with hot reload on :5173
npm test                                           # SQLite + PostgreSQL (PGlite) test suites
```
