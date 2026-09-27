# Git hook: reservation check

Agents are asked to respect file reservations; the git hook makes it automatic for everyone,
including people committing by hand. Before a commit (and a push) it checks the files involved
against teammates' reservations on the server.

- **warn** (default): prints who holds each file and lets the commit through.
- **block**: stops the commit/push until you coordinate. Override once with
  `COLLAB_ALLOW=1 git commit …` or `git commit --no-verify`.
- If the server cannot be reached, or no key is set, it only warns. It never stops you from working.
- Your own reservations never count as conflicts.

## Install (once per clone)

```sh
# from the repository root
curl -o collab-check.mjs https://mcp.example.com/hooks/collab-check.mjs
node collab-check.mjs install            # or: install --block
```

This adds `pre-commit` and `pre-push` hooks, keeps a copy of the script in `.collab/`, and writes
`.collab.json` if there is none:

```json
{ "url": "https://mcp.example.com", "project": "sailing", "mode": "warn" }
```

Commit `.collab.json` and `.collab/collab-check.mjs` (no secrets in either) so teammates only run
`node .collab/collab-check.mjs install`. Your key stays in the environment:

```sh
export COLLAB_TOKEN="sbc_…"      # macOS / Linux
setx COLLAB_TOKEN "sbc_…"        # Windows
```

If the s&box project lives in a subfolder of the repository, add `"root": "game"` so paths match
the server's project-relative paths.

Needs Node 18 or newer. Environment overrides: `COLLAB_URL`, `COLLAB_PROJECT`, `COLLAB_MODE`.
