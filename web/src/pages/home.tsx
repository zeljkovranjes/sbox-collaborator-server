import type { Activity, Agent, Change, Me, Overview, Project } from '../api';
import { ago, Avatar, clock, dayLabel, Empty, Eyebrow, Icon, Loading, Pill, until } from '../lib';
import { Link } from '../router';

const KIND_ICON: Record<string, string> = {
  task: 'task_alt', reservation: 'lock', commit: 'commit', change: 'published_with_changes', breaking_change: 'warning', agent: 'smart_toy', message: 'forum',
  decision: 'gavel', knowledge: 'menu_book', test: 'science', build_failed: 'error', blocker: 'block', pull_request: 'merge', issue: 'bug_report', branch: 'alt_route', conflict: 'report', project: 'sailing',
};

/** "chomnr/claude-code@DESK" → "claude-code". */
const clientOf = (label: string | null) => (label ? (label.split('/')[1] ?? label).split('@')[0] : null);

export function activityText(a: Activity) {
  const name = a.actorName ?? '';
  let summary = a.summary;
  if (a.agentLabel && summary.startsWith(a.agentLabel)) summary = summary.slice(a.agentLabel.length).trimStart();
  const client = clientOf(a.agentLabel);
  const named = name && !summary.startsWith(name);
  return (
    <>
      {named && <b>{name} </b>}
      {summary}
      {client && <span class="faint small"> · {client}</span>}
    </>
  );
}

export function Timeline({ items, limit }: { items: Activity[]; limit?: number }) {
  if (!items.length) return <Empty icon="timeline" text="Nothing has happened yet." />;
  let lastDay = '';
  return (
    <div class="timeline">
      {items.slice(0, limit ?? items.length).map((a) => {
        const day = dayLabel(a.at);
        const header = day !== lastDay ? <div class="tl-day">{day}</div> : null;
        lastDay = day;
        return (
          <div key={a.id}>
            {header}
            <div class="tl-item" data-imp={a.importance}>
              <span class="tl-mark">
                <Icon name={KIND_ICON[a.kind] ?? 'radio_button_checked'} />
              </span>
              <div class="tl-text">{activityText(a)}</div>
              <span class="tl-time" title={new Date(a.at).toLocaleString()}>
                {clock(a.at)}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function AgentLine({ agent }: { agent: Agent }) {
  return (
    <div class="agent-line">
      <div class="row">
        <Icon name={agent.clientType === 'sbox-editor' ? 'desktop_windows' : 'smart_toy'} class="muted" style="font-size:16px" />
        <span class="small ellipsis grow">
          {agent.clientType}
          {agent.machine ? <span class="faint"> · {agent.machine}</span> : null}
          {agent.model ? <span class="faint"> · {agent.model}</span> : null}
        </span>
        <Pill value={agent.status} />
      </div>
      {agent.currentTaskTitle ? (
        <div class="task small" style="margin-top:6px">
          #{agent.currentTaskId} {agent.currentTaskTitle}
        </div>
      ) : (
        <div class="small faint" style="margin-top:6px">
          No task claimed
        </div>
      )}
      {agent.statusNote && <div class="small muted">{agent.statusNote}</div>}
      {(agent.branch || agent.files.length > 0) && (
        <div class="chips">
          {agent.branch && (
            <span class="chip" style="color:var(--green)">
              ⎇ {agent.branch}
            </span>
          )}
          {agent.files.slice(0, 5).map((f) => (
            <span class="chip" key={f} title={f}>
              {f.split('/').pop()}
            </span>
          ))}
          {agent.files.length > 5 && <span class="chip">+{agent.files.length - 5}</span>}
        </div>
      )}
    </div>
  );
}

function ChangeCard({ change }: { change: Change }) {
  const api = [...change.apisAdded.map((a) => ['+', a]), ...change.apisRemoved.map((a) => ['-', a]), ...change.apisRenamed.map((r) => ['~', `${r.from} → ${r.to}`])];
  const breaking = change.breakingChanges.length > 0;
  return (
    <div class="list-row" style="align-items:flex-start">
      <Icon name={change.status === 'started' ? 'pending' : breaking ? 'warning' : 'published_with_changes'} class={breaking ? 'red' : change.status === 'started' ? 'yellow' : 'green'} />
      <div class="grow">
        <div class="row wrap">
          <b>{change.summary}</b>
          {breaking && <span class="pill red">breaking</span>}
          {change.status === 'started' && <span class="pill yellow">in progress</span>}
        </div>
        <div class="small muted">
          {change.developerName}
          {change.taskId ? ` · #${change.taskId}` : ''}
          {change.commitSha ? ` · ${change.commitSha.slice(0, 7)}` : ''} · {ago(change.completedAt ?? change.startedAt)}
        </div>
        {api.length > 0 && (
          <div class="mono small" style="margin-top:4px">
            {api.slice(0, 6).map(([sign, text]) => (
              <div key={text} class={sign === '+' ? 'api-add' : sign === '-' ? 'api-del' : 'yellow'}>
                {sign} {text}
              </div>
            ))}
          </div>
        )}
        {breaking && <div class="small red" style="margin-top:4px">{change.breakingChanges.join(' · ')}</div>}
      </div>
    </div>
  );
}

export function HomePage({ overview, error, project, me }: { overview: Overview | undefined; error: string | null; project: Project; me: Me }) {
  if (!overview) return error ? <div class="banner red"><Icon name="error" />{error}</div> : <Loading />;
  const onlineAgents = overview.team.reduce((n, t) => n + t.agents.length, 0);
  const mine = overview.reservations.filter((r) => r.developerId === me.developer.id);
  const others = overview.reservations.filter((r) => r.developerId !== me.developer.id);

  return (
    <>
      <div class="page-head">
        <div class="grow">
          <h1>{project.name}</h1>
          <p>
            {project.kind} {project.packageIdent ? `· ${project.packageIdent}` : ''} {project.repos.length ? `· ${project.repos.map((r) => r.fullName).join(', ')}` : ''}
          </p>
        </div>
      </div>

      <div class="stat-strip">
        <div class="stat">
          <Icon name="bolt" />
          <div>
            <b>{onlineAgents}</b>
            <span>agents online</span>
          </div>
        </div>
        <div class="stat">
          <Icon name="view_kanban" />
          <div>
            <b>{overview.tasksInProgress.length}</b>
            <span>tasks in flight</span>
          </div>
        </div>
        <div class="stat">
          <Icon name="lock" />
          <div>
            <b>{overview.reservations.length}</b>
            <span>files reserved</span>
          </div>
        </div>
        <div class={`stat${overview.blockers.length ? ' alert' : ''}`}>
          <Icon name={overview.blockers.length ? 'report' : 'verified'} />
          <div>
            <b>{overview.blockers.length}</b>
            <span>{overview.blockers.length === 1 ? 'blocker' : 'blockers'}</span>
          </div>
        </div>
      </div>

      <div class="board">
        {/* lane 1: people */}
        <div class="lane lane-left">
          <div class="panel">
            <Eyebrow icon="groups" title="Who’s doing what" aside={`${overview.team.filter((t) => t.developer.online).length}/${overview.team.length} online`} />
            <div style="padding-top:6px">
              {overview.team.map(({ developer, agents }) => (
                <div class="person" key={developer.id}>
                  <div class="person-head">
                    <Avatar id={developer.id} name={developer.displayName} githubLogin={developer.githubLogin} size="lg" status={agents[0]?.status ?? 'offline'} />
                    <div class="grow">
                      <div class="person-name">
                        {developer.displayName} {developer.id === me.developer.id && <span class="faint small">(you)</span>}
                      </div>
                      <div class="small muted">{agents.length ? `${agents.length} active ${agents.length === 1 ? 'agent' : 'agents'}` : 'offline'}</div>
                    </div>
                  </div>
                  {agents.map((a) => (
                    <AgentLine agent={a} key={a.id} />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* lane 2: what is happening */}
        <div class="lane">
          {overview.blockers.length > 0 && (
            <div class="col" style="gap:8px;margin-bottom:16px">
              {overview.blockers.map((b) => (
                <div class="banner red" key={`${b.kind}${b.refId}`}>
                  <Icon name={b.kind === 'test' ? 'error' : b.kind === 'message' ? 'campaign' : 'block'} fill />
                  <div class="grow">
                    <b>{b.title}</b>
                    <div class="small" style="color:var(--text-2)">{b.detail}</div>
                  </div>
                  <span class="small faint nowrap">{ago(b.at)}</span>
                </div>
              ))}
            </div>
          )}
          <div class="panel">
            <Eyebrow icon="play_circle" title="In progress" aside={<Link href="/tasks">board →</Link>} />
            {overview.tasksInProgress.length ? (
              <div style="padding:6px 0">
                {overview.tasksInProgress.map((t) => (
                  <Link href="/tasks" class="list-row click" key={t.id}>
                    <span class="mono faint">#{t.id}</span>
                    <span class="grow ellipsis" style="font-weight:500">
                      {t.title}
                    </span>
                    {t.stale && <span class="pill ghost">owner offline</span>}
                    <span class="small muted nowrap">{t.ownerName}</span>
                    <Pill value={t.status} />
                  </Link>
                ))}
              </div>
            ) : (
              <Empty icon="coffee" text="Nobody is working on a task right now." />
            )}
          </div>
          <div class="panel">
            <Eyebrow icon="published_with_changes" title="Changes by the team" />
            {overview.recentChanges.length ? <div style="padding:6px 0">{overview.recentChanges.map((c) => <ChangeCard change={c} key={c.id} />)}</div> : <Empty icon="published_with_changes" text="Completed work shows up here." />}
          </div>
          <div class="panel">
            <Eyebrow icon="timeline" title="Live timeline" aside={<Link href="/activity">all activity →</Link>} />
            <Timeline items={overview.activity} limit={14} />
          </div>
        </div>

        {/* lane 3: files, commits, build */}
        <div class="lane">
          <div class="panel">
            <Eyebrow icon="lock" title="Reserved files" aside={<Link href="/files">manage →</Link>} />
            {overview.reservations.length ? (
              <div style="padding:6px 0">
                {[...others, ...mine].slice(0, 14).map((r) => (
                  <div class="list-row" key={r.id} title={r.reason}>
                    <Icon name={r.isDirectory ? 'folder' : 'description'} style={`color:${r.developerId === me.developer.id ? 'var(--green)' : 'var(--yellow)'}`} />
                    <div class="grow">
                      <div class="mono ellipsis">{r.path}</div>
                      <div class="tiny muted ellipsis">
                        {r.developerName}
                        {r.taskId ? ` · #${r.taskId}` : ''} · {until(r.expiresAt)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <Empty icon="lock_open" text="No files are reserved." />
            )}
          </div>
          <div class="panel">
            <Eyebrow icon="commit" title="Recent commits" aside={<Link href="/git">git →</Link>} />
            {overview.recentCommits.length ? (
              <div style="padding:6px 0">
                {overview.recentCommits.slice(0, 8).map((c) => (
                  <a class="list-row click" key={c.sha} href={c.url ?? '#'} target="_blank" rel="noreferrer">
                    <span class="mono green">{c.shortSha}</span>
                    <div class="grow">
                      <div class="ellipsis">{c.message.split('\n')[0]}</div>
                      <div class="tiny muted">
                        {c.authorLogin ?? c.authorName} · {c.branch} · {ago(c.at)}
                      </div>
                    </div>
                  </a>
                ))}
              </div>
            ) : (
              <Empty icon="commit" text="Commits arrive via the GitHub webhook." />
            )}
          </div>
          <div class="panel">
            <Eyebrow icon="science" title="Last build / playtest" />
            <div class="panel-body">
              {overview.lastTest ? (
                <div class="row" style="align-items:flex-start">
                  <Icon name={overview.lastTest.status === 'passed' ? 'check_circle' : overview.lastTest.status === 'running' ? 'progress_activity' : 'cancel'} fill class={overview.lastTest.status === 'passed' ? 'green' : overview.lastTest.status === 'running' ? 'yellow' : 'red'} />
                  <div class="grow">
                    <b>{overview.lastTest.description}</b>
                    <div class="small muted">
                      {overview.lastTest.developerName}
                      {overview.lastTest.scene ? ` · ${overview.lastTest.scene}` : ''}
                      {overview.lastTest.commitSha ? ` · ${overview.lastTest.commitSha.slice(0, 7)}` : ''} · {ago(overview.lastTest.finishedAt ?? overview.lastTest.startedAt)}
                    </div>
                    {overview.lastTest.errors[0] && <div class="codebox" style="margin-top:8px;color:var(--red)">{overview.lastTest.errors[0]}</div>}
                  </div>
                </div>
              ) : (
                <span class="muted">No test results recorded yet.</span>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
