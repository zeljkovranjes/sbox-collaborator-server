# Configuration

All configuration is environment variables. Any secret can be given as `NAME_FILE=/path` instead
(Docker/Kubernetes secrets).

| variable | default | purpose |
|---|---|---|
| `PUBLIC_URL` | `http://localhost:8080` | External https address. Used for OAuth redirects, device sign-in links, cookie `Secure`. |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Listen address. |
| `SERVER_NAME` | `Collaborator` | Shown on the sign-in pages and in the editor. |
| `SECRET_KEY` | – (required) | ≥32 random chars. Peppers key hashes, signs cookies and OAuth state. Rotating it invalidates all keys and sessions. |
| `DATABASE_URL` | – | `postgres://user:pass@host:5432/db`. Without it the server uses SQLite. |
| `SQLITE_PATH` | `./data/collaborator.sqlite` | SQLite file for local testing. |
| `ADMIN_GITHUB_LOGINS` | – | Comma-separated GitHub logins that become admins on first GitHub login. |
| `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET` | – | GitHub sign-in. |
| `GITHUB_TOKEN` | – | GitHub API token (commits, PRs, issues, backfill). |
| `GITHUB_WEBHOOK_SECRET` | – | Verifies `X-Hub-Signature-256` on `/webhooks/github`. Webhooks are refused while unset. |
| `GITHUB_API_URL` | `https://api.github.com` | GitHub Enterprise API base. |
| `AGENT_OFFLINE_AFTER` | `15m` | No call for this long → agent shown offline, owned tasks marked stale. |
| `RESERVATION_GRACE` | `45m` | Extra time after going offline before the agent's reservations are released. |
| `RESERVATION_DEFAULT_TTL` | `4h` | Reservation lifetime when the caller gives none. |
| `RESERVATION_MAX_TTL` | `72h` | Upper bound for `ttlMinutes`. |
| `MESSAGE_RATE_LIMIT` | `20` | Messages per agent per 10 minutes (anti-chatter). |
| `SESSION_TTL` | `30d` | Dashboard session lifetime. |
| `TRUST_PROXY` | `loopback` | Express trust-proxy setting (`1` behind one reverse proxy). |
| `COOKIE_SECURE` | auto (`https` PUBLIC_URL) | Force the `Secure` cookie flag. |
| `WEB_DIR` | `./dist/web` | Built dashboard location. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. |

Durations accept `30s`, `15m`, `4h`, `2d` or milliseconds.
