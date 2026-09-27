import type { Overview } from '../api';
import { ago, Avatar, Empty, Icon, Loading, Pill } from '../lib';
import { AgentLine } from './home';

export function TeamPage({ overview }: { overview: Overview | undefined }) {
  if (!overview) return <Loading />;
  return (
    <>
      <div class="page-head">
        <div class="grow">
          <h1>Active developers</h1>
          <p>Every connected coding agent and s&amp;box editor, live.</p>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:16px">
        {overview.team.map(({ developer, agents }) => {
          const reserved = overview.reservations.filter((r) => r.developerId === developer.id);
          const tasks = overview.tasksInProgress.filter((t) => t.ownerId === developer.id);
          return (
            <div class="panel" key={developer.id}>
              <div class="panel-body row" style="gap:14px">
                <Avatar id={developer.id} name={developer.displayName} githubLogin={developer.githubLogin} size="lg" status={agents[0]?.status ?? 'offline'} />
                <div class="grow">
                  <div style="font-weight:700;font-size:15px">{developer.displayName}</div>
                  <div class="small muted">
                    {developer.githubLogin ? `@${developer.githubLogin}` : developer.id} · {developer.role}
                  </div>
                </div>
                {agents.length ? <span class="pill green"><span class="dot green" /> online</span> : <span class="pill ghost">offline</span>}
              </div>
              <div style="padding:0 16px 14px">
                {agents.length === 0 && <div class="small faint">No agent connected.</div>}
                {agents.map((a) => (
                  <div key={a.id} style="margin-left:-51px">
                    <AgentLine agent={a} />
                    <div class="tiny faint" style="margin:4px 0 0 51px">
                      {a.label} · heartbeat {ago(a.lastHeartbeatAt)}
                    </div>
                  </div>
                ))}
              </div>
              {(tasks.length > 0 || reserved.length > 0) && (
                <div style="border-top:1px solid var(--line);padding:12px 16px" class="col">
                  {tasks.map((t) => (
                    <div class="row small" key={t.id}>
                      <Icon name="task_alt" class="muted" style="font-size:16px" />
                      <span class="grow ellipsis">
                        #{t.id} {t.title}
                      </span>
                      <Pill value={t.status} />
                    </div>
                  ))}
                  {reserved.length > 0 && (
                    <div class="chips">
                      {reserved.map((r) => (
                        <span class="chip" key={r.id} title={r.reason}>
                          🔒 {r.path}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {overview.team.length === 0 && <Empty icon="groups" text="No developers yet." />}
    </>
  );
}
