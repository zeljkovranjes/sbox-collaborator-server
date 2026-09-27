/** Sent to every MCP client in the initialize result (most clients put it in the system prompt). */
export const SERVER_INSTRUCTIONS = `This server connects you to your teammates' coding agents working on the same s&box project(s). It is the team's shared state: presence, tasks, file reservations, change announcements, decisions, knowledge, messages and build status. GitHub stays the source of truth for code.

Before starting work:
1. agent_register (clientType, machine, model, branch) – once per session.
2. team_catch_up (what teammates did while you were away), then project_sync_context with focus = what you are about to do, paths = files you expect to touch.
3. message_get_unread; handle blockers/requests/handoffs, then message_acknowledge.
4. Read the relevant decisions in the packet (decision_list with a query for more) and follow them.
5. Pick or create the task (task_list / task_create), then task_claim. If the claim conflicts, do not do that work: coordinate or pick another task. Work on the task's suggestedBranch, and read lastHandoff if the task has one.
6. file_check_conflict, then file_reserve the files/directories you will change (reason + taskId). Never edit files reserved by another developer without agreeing first (message_send).
7. agent_set_status working, with task, branch and files.

While working:
- Any call counts as a heartbeat; on long stretches without calls use agent_heartbeat so your reservations survive.
- Announce blockers (task_block) and important API changes early (change_start / message_send warning). Record lasting technical choices with decision_create and engine facts/gotchas with knowledge_add.
- Before editing unfamiliar files, file_history shows who touched them, when and why.
- If a tool result ends with [team notices], read them: they are unread messages, breaking changes or broken builds from teammates.
- Stopping before the task is done (out of time, blocked, switching)? task_handoff with where you got to, what comes next and gotchas – optionally to a teammate.

After work:
- Build/test (test_result: passed/failed with errors), commit with the task number in the message (e.g. "#42 Rewrite buoyancy").
- change_complete with files, APIs added/removed/renamed, behavior and BREAKING changes, tests performed, known issues, follow-ups.
- task_complete (or task_update status review), file_release all=true, agent_set_status idle.

Communication rules: messages are for things that need a person's attention – keep them short, never chat, never reply to info messages, never send messages in a loop. Put progress into status and results into change_complete.`;

export function startWorkPrompt(task: string | undefined): string {
  return `${task ? `I want you to work on: ${task}\n\n` : ''}Follow the team workflow of the collaboration server:
1. agent_register (if not yet registered this session).
2. project_sync_context with focus="${task ?? '<the task>'}" and the paths you expect to touch.
3. message_get_unread and acknowledge what you handled.
4. Check the relevant decisions and teammates' reservations; if another developer is already on this, tell me before doing anything.
5. Find or create the task, task_claim it, file_check_conflict + file_reserve the files, agent_set_status working.
Then do the work. When done: build/test and test_result, commit (task number in the message), change_complete with a full structured summary, task_complete, file_release all=true, agent_set_status idle.`;
}
