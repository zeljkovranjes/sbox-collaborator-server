# Team workflow – s&box collaboration server

Copy this section into your project's `AGENTS.md` (Codex, OpenCode, Cursor) or `CLAUDE.md`
(Claude Code). It tells your coding agent how to work alongside the other developer's agents
through the `collaborator` MCP server. It contains no secrets and is safe to commit.

---

## Working with the team (collaborator MCP)

This project is developed by several people, each with their own coding agent. The
`collaborator` MCP server is our shared state: who is doing what, tasks, file reservations,
change announcements, decisions, knowledge, messages and build status. GitHub stays the source
of truth for code. Use the server – never make me copy context between agents by hand.

### Before starting work
1. `agent_register` – clientType (`claude-code`, `codex`, `cursor`, `opencode`), machine name,
   model, current git branch. Once per session.
2. `project_sync_context` with `focus` = what you are about to do and `paths` = files you expect
   to touch. Read it all: teammates' current work, reservations, breaking API changes, decisions.
3. `message_get_unread`. Handle blockers, requests and handoffs; `message_acknowledge` them.
4. Check the relevant decisions (in the packet; `decision_list` with a query for more). Follow
   them. If you need to break one, stop and ask me.
5. Find the task (`task_list`) or create it (`task_create`), then `task_claim`. If the claim
   fails because someone else owns it, do NOT do that work – tell me.
6. `file_check_conflict`, then `file_reserve` the files/directories you will change (with the
   task id and a reason). Directories end with `/`.
7. `agent_set_status` → `working`, with task, branch and the files you are editing.

### While working
- Never edit files reserved by another developer unless we agreed. If you must, send them a
  short `message_send` first.
- Any tool call counts as a heartbeat. During long stretches without calls, `agent_heartbeat`.
- Announce blockers early (`task_block`). Announce API changes others depend on early
  (`change_start` or a `warning` message).
- Record lasting technical choices with `decision_create`; engine facts, gotchas and
  workarounds with `knowledge_add` (tags: networking, physics, rendering, shader, animation, ui,
  audio, asset, sbox-api, bug, workaround).
- If a tool result ends with `[team notices]`, read them: unread messages, breaking changes or
  broken builds from teammates.

### After work
1. Build and test (compile in the s&box editor, run the relevant scene). Record it with
   `test_result` (passed / failed with the errors). A failure on a commit warns everyone.
2. Commit with the task number in the message, e.g. `#42 Rewrite buoyancy`.
3. `change_complete` with: summary, task, branch, commit, files, assets, APIs added / removed /
   renamed, behavior changes, **breaking changes**, tests performed, known issues, follow-ups.
4. `task_complete` (or `task_update` status `review` when it needs a PR review).
5. `file_release` with `all=true`.
6. `agent_set_status` → `idle`.

### Communication rules
- Messages are for things that need a person's attention. Keep them short and structured.
- Never chat, never reply to `info` messages, never send messages in a loop.
- Progress goes into `agent_set_status`; results go into `change_complete`.
