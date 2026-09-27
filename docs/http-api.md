# HTTP API

Everything an MCP client can do is also available over plain HTTP. The web dashboard and the
s&box editor library (`collaborator`) use this API. All bodies are JSON, all timestamps are
ISO-8601 UTC strings, all field names are camelCase.

Base URL: `https://mcp.example.com` (your deployment).

## Authentication

Send an access key on every request:

```
Authorization: Bearer sbc_<keyId>_<secret>
```

The dashboard uses an HttpOnly session cookie instead (after GitHub or access-key login). Cookie
requests that change state must also send `X-Collab-Request: 1`.

Access keys carry scopes:

| scope   | allows                                                            |
|---------|-------------------------------------------------------------------|
| `read`  | every read tool, the event stream                                 |
| `write` | everything in `read` plus tools that change shared state         |
| `admin` | everything plus developer, key and project administration        |

A key may also be limited to a list of project ids.

### Joining a server: address → server key → GitHub

New teammates join with three things, in this order:

1. **Server address** (domain or IP). Clients check it with `GET /api/server-info` (no auth):
   `{ ok:true, result:{ "name": "Sailing Team", "version": "1.0.0", "githubLogin": true, "keyLogin": true } }`.
2. **Server key** – a join key an admin created (`sbj_…`, revocable, optional expiry / max uses /
   bound GitHub login). Validate it with `POST /api/auth/server-key/check` `{ "serverKey" }` →
   `{ ok:true, result:{ "valid": true, "serverName": "…" } }` (or `401 invalid_server_key`).
   Developers who already have an account (known GitHub login) may skip the key: send
   `serverKey: null`.
3. **GitHub login** in the browser. The first GitHub login made with a valid server key creates
   the developer account; later logins only need GitHub.

### Device sign-in (used by the s&box editor)

1. `POST /api/auth/device` `{ "clientName": "s&box editor on DESKTOP-1", "clientType": "sbox-editor", "serverKey": "sbj_…" }`
   → `{ "deviceCode", "userCode": "ABCD-EFGH", "verificationUri", "verificationUriComplete", "interval": 5, "expiresIn": 600 }`
   (`401 invalid_server_key` when a key was sent and is wrong.)
2. Open `verificationUriComplete` in the browser. The page shows the code and a
   "Continue with GitHub" button; after GitHub login the device is approved for that developer.
   A GitHub account that is not yet a developer is only accepted if the device request carried a
   valid server key.
3. Poll `POST /api/auth/device/token` `{ "deviceCode" }` every `interval` seconds:
   - `428` `{ ok:false, error:{ code:"authorization_pending" } }` → keep polling
   - `429` `{ code:"slow_down" }` → add 5 s to the interval
   - `403` `{ code:"access_denied" }` / `410` `{ code:"expired_token" }` → stop
   - `200` `{ ok:true, result:{ "token": "sbc_…", "developer": Developer, "key": AccessKey } }`

The token is shown once. Store it outside the project (per-user editor storage).

### Other auth endpoints

| method | path                       | purpose                                     |
|--------|----------------------------|---------------------------------------------|
| GET    | `/api/me`                  | `{ developer, key, scopes, projectIds }`    |
| GET    | `/auth/github/login`       | start GitHub OAuth (browser)                |
| GET    | `/auth/github/callback`    | OAuth redirect target                       |
| POST   | `/api/auth/key-login`      | `{ token }` → session cookie (dashboard)    |
| POST   | `/api/auth/logout`         | end the dashboard session                   |

## Responses

Success: `200 { "ok": true, "result": <value>, "notices": ["…"]? }`

Failure: `4xx/5xx { "ok": false, "error": { "code": "…", "message": "…", "details": {…}? } }`

Error codes: `unauthorized` (401), `forbidden` (403), `not_found` (404), `invalid_input` (400),
`conflict` (409), `rate_limited` (429), `internal` (500).

`notices` carries short, important nudges for the caller (unread blocker messages, a breaking
change from a teammate since the last sync, a reservation about to expire).

## Tools over HTTP

```
POST /api/tools/<toolName>
Authorization: Bearer …
X-Collab-Agent: <agentId>      (optional: the agent session making the call)
Content-Type: application/json

{ …tool arguments… }
```

The arguments and results are exactly the MCP tools' (see [mcp-tools.md](mcp-tools.md)).
`GET /api/tools` lists tool names, descriptions, required scope and JSON schemas.

Calls that carry `X-Collab-Agent` count as a heartbeat for that agent.

## Dashboard / editor endpoints

| method | path                                   | result                                   |
|--------|----------------------------------------|------------------------------------------|
| GET    | `/api/overview?project=<id>`           | `Overview` (home page packet)            |
| GET    | `/api/messages?project=<id>&limit=50`  | `Message[]` (all recent, with read state)|
| POST   | `/api/assets/bulk`                     | editor asset scan upload (below)         |
| GET    | `/api/events?project=<id>`             | Server-Sent Events stream                |
| GET    | `/healthz`                             | `{ ok, db, version, uptimeSeconds }`     |
| POST   | `/webhooks/github`                     | GitHub webhook receiver                  |

### `POST /api/assets/bulk` (scope `write`)

```json
{
  "project": "sailing",
  "fullScan": true,
  "assets": [
    { "path": "Assets/Ships/Ship.vmdl", "dependencies": ["Assets/Ships/Ship.fbx", "Assets/Ships/Ship.vmat"], "metadata": { "compiled": true } }
  ],
  "removed": ["Assets/Old/Thing.vmat"]
}
```

→ `{ "upserted": 120, "links": 340, "removed": 1 }`. With `fullScan: true`, assets that the editor
did not report and that came from a previous editor scan are marked removed.

### Server-Sent Events

`GET /api/events?project=sailing` (bearer or cookie). Each event:

```
event: task_claimed
data: {"type":"task_claimed","projectId":"sailing","at":"…","actor":{"developerId":"chomnr","agentId":"…"},"data":{…}}
```

A `: ping` comment is sent every 25 s. Event types:

`agent_registered`, `agent_status_changed`, `agent_offline`, `task_created`, `task_claimed`,
`task_updated`, `task_completed`, `file_reserved`, `file_released`, `reservation_expired`,
`change_started`, `change_completed`, `change_abandoned`, `message_received`, `commit_detected`,
`branch_updated`, `pull_request_updated`, `issue_updated`, `decision_created`,
`decision_superseded`, `knowledge_added`, `test_started`, `test_result`, `build_broken`,
`asset_changed`, `project_updated`, `activity`.

`data` holds the affected entity (e.g. the `Task` for task events). Every event is also sent
as an `activity` event carrying the `Activity` row when it produces one.

## Entities

```ts
Developer   { id, displayName, githubLogin, role: "admin"|"member", online: boolean }
AccessKey   { id, name, prefix, scopes: string[], projectIds: string[]|null, createdAt, lastUsedAt, expiresAt, revokedAt }

Project     { id, name, kind: "game"|"library"|"tool", packageIdent, defaultBranch,
              repos: { fullName, defaultBranch }[], summary, conventions, milestone,
              importantDirs: { path, description }[], structure, createdAt, updatedAt }

Agent       { id, developerId, developerName, projectId, clientType, machine, model, label,
              status: "idle"|"planning"|"working"|"testing"|"blocked"|"reviewing"|"offline",
              statusNote, currentTaskId, currentTaskTitle, branch, files: string[],
              startedAt, lastHeartbeatAt, online: boolean }

Task        { id: number, projectId, title, description, status: "backlog"|"available"|"claimed"|
              "in_progress"|"blocked"|"review"|"done", priority: "low"|"normal"|"high"|"urgent",
              ownerId, ownerName, agentId, relatedFiles: string[], relatedAssets: string[],
              dependsOn: number[], branch, githubIssue, githubPr, blockedReason,
              completionSummary, createdBy, createdAt, updatedAt, claimedAt, completedAt,
              version: number, stale: boolean }

Reservation { id, projectId, path, isDirectory, developerId, developerName, agentId, agentLabel,
              taskId, taskTitle, reason, branch, createdAt, expiresAt }

Conflict    { path, relation: "exact"|"inside"|"contains", reservation: Reservation, message }

Activity    { id, projectId, at, actorId, actorName, agentId, agentLabel, kind, summary,
              refType, refId, importance: 0|1|2|3 }

Message     { id, projectId, type: "info"|"question"|"warning"|"blocker"|"request"|"handoff",
              fromDeveloperId, fromName, fromAgentId, toDeveloperId, toAgentId, broadcast,
              subject, body, taskId, paths: string[], createdAt, readAt, ackedAt }

Commit      { sha, shortSha, projectId, repo, branch, message, authorName, authorLogin,
              developerId, url, at, added: string[], modified: string[], removed: string[],
              taskId }

TestRun     { id, projectId, developerId, agentId, commitSha, branch, build, scene, description,
              status: "running"|"passed"|"failed"|"error", errors: string[], logs: string[],
              screenshots: string[], startedAt, finishedAt }

Overview    { project: Project, me: Developer, team: { developer: Developer, agents: Agent[] }[],
              reservations: Reservation[], tasksInProgress: Task[], blockers: Blocker[],
              recentCommits: Commit[], recentChanges: Change[], activity: Activity[],
              unreadMessages: number, lastTest: TestRun|null }

Blocker     { kind: "task"|"message"|"test", title, detail, at, refId }
```

## v1.1 additions

| method | path | result |
|---|---|---|
| PATCH | `/api/me` `{ displayName?, discordUserId? }` | `Developer` |
| GET | `/api/digests?project=<id>&limit=10` | `Digest[]` (weekly, newest first) |
| GET | `/hooks/collab-check.mjs` | the git hook script (public, no secrets) |

New SSE event types: `task_handoff`, `digest_created`.
