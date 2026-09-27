# Developer workflow

## The experience

> You: "Work on the sailing physics."

1. Your agent registers and calls `project_sync_context(focus: "sailing physics")`. The packet
   says your friend's agent is `testing` the storm system on `feat/storms`, that `Assets/Weather/`
   is reserved by them, that D3 says "network authority stays on the boat owner", and that
   there is an available task "#1 Sailing physics buoyancy rewrite".
2. It claims #1 and reserves `Code/BoatController.cs` and `Code/Ocean/`. Your friend's agent sees
   `chomnr claimed "Sailing physics buoyancy rewrite"` on its next call (as a team notice when it
   matters) and in its next sync; the dashboard and the s&box editor update live.
3. When done, your agent commits `#1 Rewrite buoyancy`, records the build/test result and
   publishes `change_complete`:
   - files: `Code/BoatController.cs`, `Code/Ocean/Buoyancy.cs`
   - API: removed `AddWaterForce()`, added `ApplyBuoyancyForce()`
   - breaking: boat components using `AddWaterForce` must migrate
4. Your friend's agent starts its next task: the sync packet already lists your change with the
   API diff and the breaking note at the top. Nobody copied anything between chats.

## Rules of thumb for humans

- One access key per machine/agent. Name them (`desk – claude code`) so you know what to revoke.
- Keep the **Project** tab (summary, conventions, milestone, important dirs) short and current –
  every agent reads it first.
- Record decisions that should outlive a conversation (`decision_create`, or the Decisions tab).
- Use the s&box editor panel to reserve assets you edit by hand (right-click an asset →
  *Reserve for editing*) – agents will see and respect it.

## The agent contract

See [../clients/AGENTS.md](../clients/AGENTS.md). The server also sends a short version as MCP
server instructions and offers a `start_work` prompt.

## States

- Agent: `idle`, `planning`, `working`, `testing`, `blocked`, `reviewing`, `offline` (no call for
  `AGENT_OFFLINE_AFTER`).
- Task: `backlog` → `available` → `claimed` → `in_progress` → (`blocked` | `review`) → `done`.
  Claiming is atomic. A task whose owning agent is offline is shown as *stale* and can be taken
  over with `force` + reason (the owner gets a `handoff` message).
- Reservation: active until released, expired (TTL), or dropped `RESERVATION_GRACE` after its
  agent went offline. Completing or releasing a task releases its reservations.
