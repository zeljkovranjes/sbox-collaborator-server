# MCP tools

All tools are served at `POST /mcp` (Streamable HTTP) and at `POST /api/tools/<name>`.
Arguments are camelCase JSON. `project` is a project id; when omitted, the calling agent's
project is used. `agentId` is optional everywhere: MCP sessions remember the agent registered
through them, HTTP callers send `X-Collab-Agent`.

Scope: **R** = `read`, **W** = `write`, **A** = `admin`.

Use `/mcp?profile=core` for clients that limit the number of tools (Cursor). The core profile
keeps the tools marked ★.

## Projects

| tool | scope | arguments | result |
|---|---|---|---|
| `project_list` ★ | R | – | `Project[]` |
| `project_get` | R | `project` | `Project` |
| `project_get_context` | R | `project` | project summary, conventions, dirs, milestone, active developers/agents |
| `project_update_context` | W | `project`, `name?`, `summary?`, `conventions?`, `milestone?`, `importantDirs?`, `structure?`, `packageIdent?`, `defaultBranch?`, `kind?` | `Project` |
| `project_create` | A | `id`, `name`, `kind`, `repos?: string[]` (`owner/name`), `defaultBranch?`, `packageIdent?`, `summary?` | `Project` |
| `project_get_activity` | R | `project`, `limit?` (≤200), `since?` | `Activity[]` |
| `project_get_recent_changes` | R | `project`, `limit?`, `since?`, `includeStarted?` | `Change[]` |
| `project_sync_context` ★ | R | `project`, `focus?` (free text: the task you are about to do), `paths?: string[]`, `format?: "text"\|"json"` | compact context packet |

## Agents

| tool | scope | arguments | result |
|---|---|---|---|
| `agent_register` ★ | W | `project`, `clientType` (`claude-code`, `codex`, `cursor`, `opencode`, `sbox-editor`, `other`), `machine?`, `model?`, `label?`, `branch?`, `resumeAgentId?` | `Agent` |
| `agent_heartbeat` ★ | W | `status?`, `note?`, `currentTaskId?`, `branch?`, `files?` | `{ agent, unreadMessages, notices }` |
| `agent_set_status` ★ | W | `status`, `note?`, `currentTaskId?`, `branch?`, `files?` | `Agent` |
| `agent_list_active` ★ | R | `project` | `Agent[]` |
| `agent_get_activity` | R | `agentId?`, `developerId?`, `limit?` | `Activity[]` |

An agent goes offline after `AGENT_OFFLINE_AFTER` without any call. Its reservations are
released `RESERVATION_GRACE` later.

## Tasks

| tool | scope | arguments | result |
|---|---|---|---|
| `task_create` ★ | W | `project`, `title`, `description?`, `priority?`, `status?` (`backlog`\|`available`), `relatedFiles?`, `relatedAssets?`, `dependsOn?: number[]`, `branch?`, `githubIssue?` | `Task` |
| `task_list` ★ | R | `project`, `status?: string[]`, `ownerId?`, `mine?`, `query?`, `limit?` | `Task[]` |
| `task_get` ★ | R | `taskId` | `Task` + dependencies, reservations, changes |
| `task_claim` ★ | W | `taskId`, `branch?`, `force?`, `reason?` | `Task` (conflict error names the owner) |
| `task_update` ★ | W | `taskId`, `status?`, `title?`, `description?`, `priority?`, `relatedFiles?`, `relatedAssets?`, `dependsOn?`, `branch?`, `githubIssue?`, `githubPr?`, `expectedVersion?` | `Task` |
| `task_block` ★ | W | `taskId`, `reason` | `Task` |
| `task_release` ★ | W | `taskId`, `reason?`, `status?` (`available`\|`backlog`) | `Task` |
| `task_complete` ★ | W | `taskId`, `summary`, `commitSha?`, `status?` (`done`\|`review`) | `Task` |

Claiming is atomic: exactly one of two simultaneous claims wins; the other gets
`conflict` with the winner's name, agent and task status. `force` takes over a task owned by
someone else and sends them a `handoff` message.

## File and asset reservations

| tool | scope | arguments | result |
|---|---|---|---|
| `file_reserve` ★ | W | `project`, `paths: string[]` (a trailing `/` marks a directory), `reason`, `taskId?`, `branch?`, `ttlMinutes?`, `force?` | `{ reserved: Reservation[], conflicts: Conflict[], message }` |
| `file_release` ★ | W | `project`, `paths?`, `reservationIds?`, `all?` | `{ released: number }` |
| `file_list_reservations` ★ | R | `project`, `path?`, `developerId?`, `mine?` | `Reservation[]` |
| `file_check_conflict` ★ | R | `project`, `paths: string[]` | `{ clear: boolean, conflicts: Conflict[], message }` |

Reservations are advisory. Without `force`, a path that overlaps another developer's
reservation is not reserved and comes back in `conflicts`.

## s&box assets

| tool | scope | arguments | result |
|---|---|---|---|
| `asset_search` ★ | R | `project`, `query?`, `type?`, `tag?`, `limit?` | `Asset[]` |
| `asset_get` | R | `project`, `path` | `Asset` + direct dependencies/references + active reservation |
| `asset_register` | W | `project`, `path`, `description?`, `tags?`, `dependencies?: string[]`, `content?` (text of a .vmdl/.vmat/.prefab/.scene… to extract references), `metadata?` | `Asset` |
| `asset_update` | W | `project`, `path`, `description?`, `tags?`, `dependencies?`, `content?`, `metadata?` | `Asset` |
| `asset_find_dependencies` | R | `project`, `path`, `depth?` (≤6) | tree of what the asset uses |
| `asset_find_references` | R | `project`, `path`, `depth?` | tree of what uses the asset |
| `asset_recent_changes` | R | `project`, `limit?`, `type?` | recently changed assets with commit and author |

Asset types: `code` (.cs, .razor), `style` (.scss), `shader` (.shader, .shdrgrph), `model` (.vmdl),
`compiled` (…_c), `material` (.vmat), `texture` (.vtex), `sound` (.vsnd, .sound), `scene`
(.scene), `prefab` (.prefab), `map` (.vmap), `animgraph` (.animgraph, .vanmgrph),
`source_model` (.fbx, .glb, .gltf, .obj, .dmx, .smd), `image` (.png, .tga, .jpg, .psd, .exr),
`audio` (.wav, .mp3, .ogg), `particle` (.vpcf), `other`.

## Git and GitHub

| tool | scope | arguments | result |
|---|---|---|---|
| `git_get_status` ★ | R | `project` | default branch head, active branches with who is on them, open PRs, latest test per branch |
| `git_get_recent_commits` ★ | R | `project`, `branch?`, `limit?`, `since?`, `author?` | `Commit[]` |
| `git_get_branch_activity` | R | `project`, `limit?` | branches with last push, pusher, linked tasks/agents |
| `git_get_commit` | R | `project`, `sha` | commit with files and stats (GitHub API when not cached) |
| `git_get_changed_files` | R | `project`, `base`, `head` | files changed between two refs |
| `github_get_issues` | R | `project`, `state?`, `limit?` | issues |
| `github_get_pull_requests` | R | `project`, `state?`, `limit?` | pull requests |
| `github_create_issue` | W | `project`, `title`, `body?`, `labels?`, `taskId?` | issue (linked to the task) |
| `github_link_task` | W | `taskId`, `issue?`, `pullRequest?` | `Task` |
| `github_get_recent_activity` | R | `project`, `limit?` | pushes, PRs, issues, merges |

## Change announcements

| tool | scope | arguments | result |
|---|---|---|---|
| `change_start` ★ | W | `project`, `summary`, `taskId?`, `branch?`, `files?` | `Change` |
| `change_complete` ★ | W | `changeId?`, `project?`, `summary`, `taskId?`, `branch?`, `commitSha?`, `files?`, `assets?`, `apisAdded?`, `apisRemoved?`, `apisRenamed?: {from,to}[]`, `behaviorChanges?`, `breakingChanges?`, `testsPerformed?`, `knownIssues?`, `followUps?` | `Change` |
| `change_abandon` | W | `changeId`, `reason` | `Change` |

## Decisions

| tool | scope | arguments | result |
|---|---|---|---|
| `decision_create` ★ | W | `project`, `title`, `context`, `decision`, `reasoning`, `affectedSystems?`, `tags?`, `taskId?`, `commitSha?`, `status?` (`proposed`\|`accepted`) | `Decision` |
| `decision_list` ★ | R | `project`, `query?`, `system?`, `status?`, `limit?` | `Decision[]` (relevance ranked when `query` given) |
| `decision_get` | R | `decisionId` | `Decision` |
| `decision_supersede` | W | `decisionId`, `newDecision` (same fields as create), `reason` | `{ old, new }` |

## Messages

| tool | scope | arguments | result |
|---|---|---|---|
| `message_send` ★ | W | `project`, `to` (developer id or agent id), `type`, `body` (≤1000 chars), `subject?`, `taskId?`, `paths?` | `Message` |
| `message_broadcast` | W | `project`, `type`, `body`, `subject?`, `taskId?`, `paths?` | `Message` |
| `message_get_unread` ★ | R | `project?`, `markRead?` | `Message[]` |
| `message_acknowledge` ★ | W | `messageIds: number[]` | `{ acknowledged }` |

Agents are limited to `MESSAGE_RATE_LIMIT` messages per 10 minutes, and identical messages
within 10 minutes are dropped. Messages never trigger replies on their own.

## Knowledge

| tool | scope | arguments | result |
|---|---|---|---|
| `knowledge_add` ★ | W | `project?` (omit for global), `title`, `body`, `tags?` | `Knowledge` |
| `knowledge_search` ★ | R | `project?`, `query?`, `tags?`, `limit?` | `Knowledge[]` |
| `knowledge_update` | W | `knowledgeId`, `title?`, `body?`, `tags?`, `archived?` | `Knowledge` |

Suggested tags: `networking physics rendering shader animation ui audio asset sbox-api bug workaround`.

## Build and test events

| tool | scope | arguments | result |
|---|---|---|---|
| `test_start` | W | `project`, `description`, `commitSha?`, `branch?`, `build?`, `scene?` | `TestRun` |
| `test_result` ★ | W | `testId?` or (`project`, `description`), `status` (`passed`\|`failed`\|`error`), `commitSha?`, `branch?`, `build?`, `scene?`, `errors?`, `logs?`, `screenshots?` | `TestRun` |
| `test_get_recent` | R | `project`, `branch?`, `commitSha?`, `limit?` | `TestRun[]` |

A failed result on a commit broadcasts a `build_broken` event and a warning to the team.

## Activity

| tool | scope | arguments | result |
|---|---|---|---|
| `activity_recent` ★ | R | `project`, `limit?`, `since?`, `minImportance?` | `Activity[]` |

## Catch-up, history, handoffs, digests (v1.1)

| tool | scope | arguments | result |
|---|---|---|---|
| `team_catch_up` ★ | R | `project`, `since?` (default: when you last caught up, max 14 days) | `CatchUp` – what changed while you were away |
| `file_history` ★ | R | `project`, `path` (file or folder/), `limit?` | `FileHistory` – who touched it, when, why |
| `task_handoff` ★ | W | `taskId`, `summary` (where I got to), `next?`, `gotchas?`, `files?`, `to?` (developer id), `keepReservations?` | `Task` – note stored, task released (or handed to `to`), owner messaged |
| `team_digest` | R | `project`, `days?` (1–31, default 7) | `Digest` – team-wide summary for the period |

```ts
CatchUp     { since, until, summary: string /* compact markdown */, counts: { commits, changes, breaking, tasksCompleted, tasksClaimed, decisions, knowledge, messages, failedTests } }
FileHistory { path, commits: { sha, shortSha, message, author, developerId, at, branch, taskId, url, change: "added"|"modified"|"removed" }[],
              changes: { id, summary, developerName, completedAt, breaking: boolean, taskId }[],
              tasks: { id, title, status, ownerName }[], reservations: Reservation[], asset: Asset|null }
TaskNote    { id, taskId, kind: "handoff"|"note", authorId, authorName, summary, next, gotchas, files: string[], createdAt }
Digest      { projectId, from, to, summary: string /* markdown */, stats: {…} }
```

Task additions (every Task result): `suggestedBranch` (`task.branch` or `task/<id>-<slug>`) and
`lastHandoff: TaskNote | null`. `task_get` also returns `notes: TaskNote[]`. `task_claim` returns
the claimed Task including `suggestedBranch`.

`test_result` accepts `build` values the editor uses: `"editor-compile"` (automatic compile
results) and `"playtest"` (automatic play-mode sessions).

`project_update_context` accepts `discordWebhookUrl` (write; stored encrypted, never returned –
the project shows `discordConfigured: true`). Developers set `discordUserId` via `PATCH /api/me`
so notifications can @mention them.
