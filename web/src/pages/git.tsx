import { api, type Commit, type Project } from '../api';
import { ago, Empty, Eyebrow, Icon, Loading, Pill, useLoad } from '../lib';

interface GitStatus {
  repos: string[];
  defaultBranch: string;
  head: { sha: string; message: string; author: string; at: string } | null;
  activeBranches: { repo: string; name: string; headSha: string | null; lastPushAt: string; lastPusher: string | null; agents: string[]; tasks: string[] }[];
  openPullRequests: { number: number; title: string; author: string | null; head: string | null; base: string | null; url: string | null; taskId: number | null }[];
  buildStatus: { branch: string | null; status: string; commit: string | null; description: string; by: string; at: string | null }[];
  webhooksConfigured: boolean;
}

export function GitPage({ project }: { project: Project }) {
  const status = useLoad(() => api.tool<GitStatus>('git_get_status', { project: project.id }), [project.id]);
  const commits = useLoad(() => api.tool<Commit[]>('git_get_recent_commits', { project: project.id, limit: 50 }), [project.id]);
  const s = status.data;
  return (
    <>
      <div class="page-head">
        <div class="grow">
          <h1>Git activity</h1>
          <p>{project.repos.length ? project.repos.map((r) => r.fullName).join(', ') : 'No repository linked yet (Project tab).'} – GitHub stays the source of truth.</p>
        </div>
      </div>
      {s && !s.webhooksConfigured && (
        <div class="banner yellow" style="margin-bottom:16px">
          <Icon name="webhook" />
          <span>GitHub webhooks are not configured, so pushes are not tracked live. See docs/github-webhooks.md.</span>
        </div>
      )}
      <div class="split">
        <div class="panel">
          <Eyebrow icon="commit" title="Commits" aside={s?.head ? `${s.defaultBranch} @ ${s.head.sha}` : undefined} />
          {!commits.data ? (
            <Loading />
          ) : commits.data.length === 0 ? (
            <Empty icon="commit" text="No commits recorded yet." />
          ) : (
            <div style="padding:6px 0">
              {commits.data.map((c) => (
                <a class="list-row click" key={c.sha} href={c.url ?? '#'} target="_blank" rel="noreferrer" style="align-items:flex-start">
                  <span class="mono green" style="padding-top:1px">
                    {c.shortSha}
                  </span>
                  <div class="grow">
                    <div style="font-weight:500">{c.message.split('\n')[0]}</div>
                    <div class="small muted">
                      {c.authorLogin ?? c.authorName} · <span class="mono">{c.branch}</span> · {ago(c.at)}
                      {c.taskId ? ` · task #${c.taskId}` : ''}
                    </div>
                    {c.added.length + c.modified.length + c.removed.length > 0 && (
                      <div class="tiny faint">
                        <span class="api-add">+{c.added.length}</span> <span class="yellow">~{c.modified.length}</span> <span class="api-del">-{c.removed.length}</span> files
                      </div>
                    )}
                  </div>
                </a>
              ))}
            </div>
          )}
        </div>
        <div>
          <div class="panel">
            <Eyebrow icon="alt_route" title="Active branches" />
            {!s ? (
              <Loading />
            ) : s.activeBranches.length === 0 ? (
              <Empty icon="alt_route" text="No branch pushes yet." />
            ) : (
              <div style="padding:6px 0">
                {s.activeBranches.map((b) => (
                  <div class="list-row" key={b.repo + b.name} style="align-items:flex-start">
                    <Icon name="alt_route" />
                    <div class="grow">
                      <div class="mono">{b.name}</div>
                      <div class="tiny muted">
                        {b.lastPusher ?? '?'} · {ago(b.lastPushAt)}
                        {b.headSha ? ` · ${b.headSha}` : ''}
                      </div>
                      {b.agents.map((a) => (
                        <div class="tiny green" key={a}>
                          {a}
                        </div>
                      ))}
                      {b.tasks.map((t) => (
                        <div class="tiny" key={t}>
                          {t}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div class="panel">
            <Eyebrow icon="merge" title="Open pull requests" />
            {!s ? null : s.openPullRequests.length === 0 ? (
              <Empty icon="merge" text="No open pull requests." />
            ) : (
              <div style="padding:6px 0">
                {s.openPullRequests.map((p) => (
                  <a class="list-row click" key={p.number} href={p.url ?? '#'} target="_blank" rel="noreferrer">
                    <span class="mono muted">#{p.number}</span>
                    <div class="grow">
                      <div class="ellipsis">{p.title}</div>
                      <div class="tiny muted">
                        {p.author} · {p.head} → {p.base}
                        {p.taskId ? ` · task #${p.taskId}` : ''}
                      </div>
                    </div>
                  </a>
                ))}
              </div>
            )}
          </div>
          <div class="panel">
            <Eyebrow icon="science" title="Build status by branch" />
            {!s ? null : s.buildStatus.length === 0 ? (
              <Empty icon="science" text="Agents record builds and playtests with test_result." />
            ) : (
              <div style="padding:6px 0">
                {s.buildStatus.map((b) => (
                  <div class="list-row" key={b.branch ?? '-'}>
                    <span class="mono grow">{b.branch ?? '(no branch)'}</span>
                    <span class="tiny muted ellipsis" style="max-width:160px">
                      {b.description}
                    </span>
                    <Pill value={b.status} />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
