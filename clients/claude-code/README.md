# Claude Code

Either add the server once for your user (nothing is written into the repository):

```sh
claude mcp add --scope user --transport http collaborator https://mcp.example.com/mcp \
  --header "Authorization: Bearer ${COLLAB_TOKEN}"
```

…or commit [.mcp.json](.mcp.json) to the game repository. Claude Code expands `${COLLAB_TOKEN}`
from the environment, so every developer uses their own key and no key is committed.

Add the workflow from [../AGENTS.md](../AGENTS.md) to the project's `CLAUDE.md`.
Check the connection with `/mcp` inside Claude Code.
