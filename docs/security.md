# Security

## Identities and credentials

| credential | format | stored as | used by |
|---|---|---|---|
| Server key (invite) | `sbj_<id>_<secret>` | HMAC-SHA256(secret, `SECRET_KEY`) | a new teammate, once, before GitHub sign-in |
| Access key | `sbc_<id>_<secret>` (256-bit secret) | HMAC-SHA256(secret, `SECRET_KEY`) | MCP clients, the s&box editor, scripts |
| Dashboard session | HttpOnly cookie `<id>.<secret>` | HMAC-SHA256 | browsers |
| GitHub OAuth token | – | **never stored** (used once to read the GitHub user) | sign-in |
| GitHub API token | – | environment / secret file only | server → GitHub |

- Secrets are shown exactly once when created. Lookups use the id; secret comparison is
  constant-time.
- **Joining**: a GitHub account that is not a developer yet can only sign in with a valid server
  key (or when listed in `ADMIN_GITHUB_LOGINS`). Server keys are single-use by default, expire
  (14 days by default), can be bound to one GitHub login, and can be revoked.
- **Revocation** takes effect on the next request – including open MCP sessions, which are
  re-authenticated on every request. Disabling a developer ends their sessions and keys.

## Permissions

- Scopes per key: `read` (read-only clients), `write`, `admin` (only for admin developers).
- Project access per developer and per key (intersection); everything is filtered by it,
  including the realtime stream.
- Developers can only change their own agents, reservations, changes and tests; task status is
  changed by the owner (or an admin); take-overs need `force` + a reason and notify the owner.

## Transport and web

- Run behind HTTPS (Caddy / nginx configs included). The server warns at start-up when
  `PUBLIC_URL` is not https. HSTS is sent for https deployments.
- Cookie-authenticated state changes require the `X-Collab-Request: 1` header (CSRF), cookies are
  `HttpOnly`, `SameSite=Lax`, `Secure` on https.
- Strict Content-Security-Policy, `X-Frame-Options: DENY`, `nosniff`, no `X-Powered-By`.
- GitHub webhooks are HMAC-verified over the raw body and de-duplicated.
- Rate limits on key checks, logins and device sign-in (brute force), on invalid bearer keys,
  and on messages (anti-chatter).
- All input is validated with zod schemas; paths are normalised and `..` / absolute paths are
  rejected.

## Keeping secrets out of git

- `.env`, `credentials.json`, `secrets/`, keys and certificates are in `.gitignore` (server and
  the s&box library).
- The s&box editor stores its access key in per-user editor storage (`EditorCookie`), never in
  the project folder, and never stores the server key.
- MCP client configs in [clients/](../clients) read the key from `COLLAB_TOKEN`, so they are safe
  to commit.
- If a key leaks: revoke it in the dashboard (or `cli.js key revoke <id>`), create a new one.

## Reporting

Open a private security advisory on the repository.
