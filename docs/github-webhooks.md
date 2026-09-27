# GitHub webhooks

Webhooks let the server notice pushes, branches, pull requests, reviews, merges and issues the
moment they happen, and correlate them with developers, agents, tasks and reserved files.

## Setup (per repository, or once for an organization)

Repository → **Settings → Webhooks → Add webhook**

| field | value |
|---|---|
| Payload URL | `https://mcp.chomnr.com/webhooks/github` |
| Content type | `application/json` |
| Secret | the value of `GITHUB_WEBHOOK_SECRET` |
| Events | *Let me select*: **Pushes, Branch or tag creation, Branch or tag deletion, Pull requests, Pull request reviews, Issues** |

The repository must be listed in the project's repos (Project tab or `project_update_context`),
otherwise deliveries are acknowledged and ignored. GitHub's **Recent Deliveries** tab shows each
result (`processed`, `duplicate`, `ignored`).

## What happens on a push

1. The signature is verified against the raw body (constant-time); failures get `401`.
2. Duplicate deliveries (same `X-GitHub-Delivery`) are ignored.
3. Each commit is stored with its author mapped to a developer (by GitHub login), a **task**
   (a `#42` / `task-42` reference in the message, else the task whose branch matches) and the
   **agent** that was working on that task or branch.
4. Changed s&box assets (`.vmdl`, `.vmat`, `.shader`, `.scene`, …) are marked changed with the
   commit and author.
5. A `commit_detected` event and an activity line go to everyone
   (`chomnr committed 3a92bc1 to feat/buoyancy: Rewrite buoyancy · #42`).
6. If the push touched files another developer has **reserved**, that developer gets a
   `warning` message and a critical activity entry.

Pull requests are linked to tasks the same way; merging a PR whose task is in `review` completes
the task.

Without webhooks, `git_get_recent_commits` falls back to reading recent commits from the GitHub
API (needs `GITHUB_TOKEN` for private repositories).
