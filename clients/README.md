# Connecting coding agents

Every developer connects each of their agents with **their own access key**. Create keys in the
dashboard (**your avatar → Connect agents & keys**), one per machine or agent, so each can be
revoked on its own.

**Keep keys out of git.** Put the key in the `COLLAB_TOKEN` environment variable on the machine
that runs the agent. All config files in this folder read it from the environment and are safe
to commit.

```sh
# macOS / Linux (~/.zshrc or ~/.bashrc)
export COLLAB_TOKEN="sbc_…"
```

```powershell
# Windows (persists for new terminals)
setx COLLAB_TOKEN "sbc_…"
```

| client | file | notes |
|---|---|---|
| Claude Code | [claude-code/](claude-code) | `claude mcp add` (user scope) or a committed `.mcp.json` using `${COLLAB_TOKEN}` |
| Codex CLI | [codex/config.toml](codex/config.toml) | `bearer_token_env_var` |
| Cursor | [cursor/mcp.json](cursor/mcp.json) | uses `?profile=core` (32 tools) because Cursor limits tool counts |
| OpenCode | [opencode/opencode.json](opencode/opencode.json) | `{env:COLLAB_TOKEN}` |
| anything else | `https://<server>/mcp` | Streamable HTTP, header `Authorization: Bearer <key>` |

Then add [AGENTS.md](AGENTS.md) to your project instructions so agents follow the team workflow.
MCP clients that support prompts can also use the server's `start_work` prompt.

Replace `mcp.example.com` with your server's address.

A read-only key (dashboard option "Read-only") lets an agent see everything without changing
anything – useful for review bots.
