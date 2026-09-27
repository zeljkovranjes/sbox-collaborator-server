import { useState } from 'preact/hooks';
import { api, type Change, type Me, type Project, type Reservation, type Task, type TaskNote } from '../api';
import { ago, Avatar, Empty, Icon, Loading, Modal, Pill, Secret, useAction, useLoad } from '../lib';

const COLUMNS: { status: string[]; title: string; icon: string }[] = [
  { status: ['backlog'], title: 'Backlog', icon: 'inventory_2' },
  { status: ['available'], title: 'Available', icon: 'radio_button_unchecked' },
  { status: ['claimed', 'in_progress'], title: 'In progress', icon: 'play_circle' },
  { status: ['blocked', 'review'], title: 'Blocked / review', icon: 'pending' },
  { status: ['done'], title: 'Done', icon: 'task_alt' },
];

type TaskDetail = Task & { dependencies: { id: number; title?: string; status?: string }[]; reservations: Reservation[]; changes: Change[]; notes: TaskNote[] };

export function TasksPage({ project, me }: { project: Project; me: Me }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const tasks = useLoad(() => api.tool<Task[]>('task_list', { project: project.id, limit: 200, ...(query ? { query } : {}) }), [project.id, query]);

  return (
    <>
      <div class="page-head">
        <div class="grow">
          <h1>Task board</h1>
          <p>Claiming is atomic – two agents can never silently take the same task.</p>
        </div>
        <div class="search" style="width:260px">
          <Icon name="search" />
          <input class="input" placeholder="Search tasks" value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
        </div>
        <button class="btn primary" onClick={() => setCreating(true)}>
          <Icon name="add" /> New task
        </button>
      </div>
      {!tasks.data ? (
        <Loading />
      ) : (
        <div class="kanban">
          {COLUMNS.map((col) => {
            const items = tasks.data!.filter((t) => col.status.includes(t.status));
            return (
              <div class="kan-col" key={col.title}>
                <div class="kan-head">
                  <Icon name={col.icon} class={col.title === 'In progress' ? 'green' : 'muted'} />
                  {col.title}
                  <span class="n">{items.length}</span>
                </div>
                <div class="kan-body">
                  {items.length === 0 && <div class="small faint" style="padding:8px">Empty</div>}
                  {items.map((t) => (
                    <div class="card row" style="align-items:stretch;gap:10px" key={t.id} onClick={() => setOpen(t.id)}>
                      <span class={`prio ${t.priority}`} />
                      <div class="grow">
                        <div class="title">{t.title}</div>
                        <div class="meta">
                          <span class="mono">#{t.id}</span>
                          {t.status !== col.status[0] && <Pill value={t.status} />}
                          {t.priority !== 'normal' && <Pill value={t.priority} />}
                          <span class="spacer" />
                          {t.stale && <Icon name="cloud_off" style="font-size:15px" class="yellow" />}
                          {t.ownerId && <Avatar id={t.ownerId} name={t.ownerName ?? t.ownerId} size="sm" />}
                        </div>
                        {t.blockedReason && <div class="small red" style="margin-top:6px">{t.blockedReason}</div>}
                        {t.lastHandoff && t.status !== 'done' && (
                          <div class="small yellow" style="margin-top:6px">
                            <Icon name="swap_horiz" style="font-size:14px;vertical-align:-2px" /> {t.lastHandoff.authorName}: {t.lastHandoff.summary.slice(0, 80)}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {open !== null && <TaskModal id={open} me={me} onClose={() => (setOpen(null), tasks.reload())} />}
      {creating && <CreateTask project={project} onClose={() => (setCreating(false), tasks.reload())} />}
    </>
  );
}

function TaskModal({ id, me, onClose }: { id: number; me: Me; onClose: () => void }) {
  const task = useLoad(() => api.tool<TaskDetail>('task_get', { taskId: id }), [id]);
  const [handoff, setHandoff] = useState(false);
  const project = task.data?.projectId;
  const team = useLoad(
    () => (project ? api.get<{ team: { developer: { id: string; displayName: string } }[] }>(`/api/overview?project=${encodeURIComponent(project)}`) : Promise.resolve(null)),
    [project],
  );
  const act = useAction();
  const t = task.data;
  const mine = t?.ownerId === me.developer.id;
  const run = async (tool: string, args: Record<string, unknown>, message: string) => {
    if (await act(() => api.tool(tool, { taskId: id, ...args }), message)) task.reload();
  };
  return (
    <>
      {handoff && t && (
        <HandoffModal
          task={t}
          teammates={(team.data?.team ?? []).map((x) => x.developer).filter((d) => d.id !== me.developer.id)}
          onClose={(done) => {
            setHandoff(false);
            if (done) onClose();
          }}
        />
      )}
    <Modal title={t ? `#${t.id} ${t.title}` : 'Task'} icon="task_alt" onClose={onClose} wide>
      {!t ? (
        <Loading />
      ) : (
        <>
          <div class="row wrap">
            <Pill value={t.status} />
            <Pill value={t.priority} />
            {t.stale && <span class="pill ghost">owner offline</span>}
            {t.branch && <span class="chip">⎇ {t.branch}</span>}
            {t.githubIssue && <span class="chip">issue #{t.githubIssue}</span>}
            {t.githubPr && <span class="chip">PR #{t.githubPr}</span>}
          </div>
          {t.description && <div class="prose">{t.description}</div>}
          {t.blockedReason && (
            <div class="banner red">
              <Icon name="block" />
              {t.blockedReason}
            </div>
          )}
          {t.notes.filter((n) => n.kind === 'handoff').slice(0, 3).map((n) => (
            <div class="banner yellow" key={n.id}>
              <Icon name="swap_horiz" />
              <div class="grow small" style="color:var(--text)">
                <b>Handoff from {n.authorName}</b> <span class="muted">· {ago(n.createdAt)}</span>
                <div>{n.summary}</div>
                {n.next && (
                  <div>
                    <span class="muted">Next:</span> {n.next}
                  </div>
                )}
                {n.gotchas && (
                  <div>
                    <span class="muted">Gotchas:</span> {n.gotchas}
                  </div>
                )}
              </div>
            </div>
          ))}
          {t.status !== 'done' && (
            <div class="field">
              <label>Branch</label>
              <Secret value={`git switch -c ${t.suggestedBranch}`} />
            </div>
          )}
          {t.completionSummary && (
            <div class="banner green">
              <Icon name="task_alt" />
              {t.completionSummary}
            </div>
          )}
          <dl class="kv">
            <dt>Owner</dt>
            <dd>{t.ownerName ?? <span class="faint">nobody</span>}</dd>
            <dt>Created</dt>
            <dd>
              {ago(t.createdAt)} by {t.createdBy}
            </dd>
            <dt>Related files</dt>
            <dd class="chips" style="margin:0">
              {t.relatedFiles.length ? t.relatedFiles.map((f) => <span class="chip" key={f}>{f}</span>) : <span class="faint">–</span>}
            </dd>
            <dt>Depends on</dt>
            <dd>{t.dependencies.length ? t.dependencies.map((d) => <div key={d.id}>#{d.id} {d.title} {d.status && <Pill value={d.status} />}</div>) : <span class="faint">–</span>}</dd>
            <dt>Reservations</dt>
            <dd>{t.reservations.length ? t.reservations.map((r) => <div class="mono" key={r.id}>{r.path}</div>) : <span class="faint">–</span>}</dd>
          </dl>
          {t.changes.length > 0 && (
            <div class="col">
              <div class="eyebrow" style="padding:0">Change announcements</div>
              {t.changes.map((c) => (
                <div key={c.id} class="small">
                  <b>{c.summary}</b> <span class="muted">– {c.developerName}, {ago(c.completedAt ?? c.startedAt)}</span>
                </div>
              ))}
            </div>
          )}
          <div class="row wrap" style="border-top:1px solid var(--line);padding-top:14px">
            {['available', 'backlog'].includes(t.status) && (
              <button class="btn primary" onClick={() => run('task_claim', {}, 'Task claimed')}>
                <Icon name="front_hand" /> Claim
              </button>
            )}
            {mine && t.status === 'claimed' && (
              <button class="btn" onClick={() => run('task_update', { status: 'in_progress' }, 'Started')}>
                <Icon name="play_arrow" /> Start
              </button>
            )}
            {mine && t.status !== 'done' && (
              <>
                <button
                  class="btn"
                  onClick={() => {
                    const summary = prompt('Completion summary');
                    if (summary) void run('task_complete', { summary }, 'Task completed');
                  }}
                >
                  <Icon name="task_alt" /> Complete
                </button>
                <button
                  class="btn"
                  onClick={() => {
                    const reason = prompt('What is blocking this?');
                    if (reason) void run('task_block', { reason }, 'Marked blocked');
                  }}
                >
                  <Icon name="block" /> Block
                </button>
                <button class="btn" onClick={() => setHandoff(true)}>
                  <Icon name="swap_horiz" /> Hand off
                </button>
                <button class="btn ghost" onClick={() => run('task_release', {}, 'Released')}>
                  Release
                </button>
              </>
            )}
            {!mine && t.ownerId && t.stale && (
              <button
                class="btn danger"
                onClick={() => {
                  const reason = prompt(`Take over from ${t.ownerName}? Reason:`);
                  if (reason) void run('task_claim', { force: true, reason }, 'Taken over');
                }}
              >
                Take over
              </button>
            )}
          </div>
        </>
      )}
    </Modal>
    </>
  );
}

function HandoffModal({ task, teammates, onClose }: { task: Task; teammates: { id: string; displayName: string }[]; onClose: (done: boolean) => void }) {
  const [summary, setSummary] = useState('');
  const [next, setNext] = useState('');
  const [gotchas, setGotchas] = useState('');
  const [to, setTo] = useState('');
  const act = useAction();
  const save = async () => {
    const ok = await act(() => api.tool('task_handoff', { taskId: task.id, summary, ...(next ? { next } : {}), ...(gotchas ? { gotchas } : {}), ...(to ? { to } : {}) }), 'Handed off');
    if (ok) onClose(true);
  };
  return (
    <Modal
      title={`Hand off #${task.id}`}
      icon="swap_horiz"
      onClose={() => onClose(false)}
      footer={
        <>
          <button class="btn ghost" onClick={() => onClose(false)}>
            Cancel
          </button>
          <button class="btn primary" disabled={!summary.trim()} onClick={save}>
            Hand off
          </button>
        </>
      }
    >
      <div class="field">
        <label>Where you got to</label>
        <textarea class="textarea" value={summary} onInput={(e) => setSummary((e.target as HTMLTextAreaElement).value)} autoFocus />
      </div>
      <div class="field">
        <label>What comes next</label>
        <textarea class="textarea" style="min-height:60px" value={next} onInput={(e) => setNext((e.target as HTMLTextAreaElement).value)} />
      </div>
      <div class="field">
        <label>Gotchas</label>
        <input class="input" value={gotchas} onInput={(e) => setGotchas((e.target as HTMLInputElement).value)} placeholder="Half-done bits, traps, where to test" />
      </div>
      <div class="field">
        <label>Give it to</label>
        <select class="select" value={to} onChange={(e) => setTo((e.target as HTMLSelectElement).value)}>
          <option value="">Nobody – back to the board</option>
          {teammates.map((d) => (
            <option value={d.id} key={d.id}>
              {d.displayName}
            </option>
          ))}
        </select>
      </div>
    </Modal>
  );
}

function CreateTask({ project, onClose }: { project: Project; onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('normal');
  const [files, setFiles] = useState('');
  const act = useAction();
  const save = async () => {
    const relatedFiles = files.split(/[\n,]/).map((f) => f.trim()).filter(Boolean);
    if (await act(() => api.tool('task_create', { project: project.id, title, description, priority, relatedFiles }), 'Task created')) onClose();
  };
  return (
    <Modal
      title="New task"
      icon="add_task"
      onClose={onClose}
      footer={
        <>
          <button class="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button class="btn primary" disabled={!title.trim()} onClick={save}>
            Create task
          </button>
        </>
      }
    >
      <div class="field">
        <label>Title</label>
        <input class="input" value={title} onInput={(e) => setTitle((e.target as HTMLInputElement).value)} placeholder="Sailing physics: buoyancy rewrite" autoFocus />
      </div>
      <div class="field">
        <label>Description</label>
        <textarea class="textarea" value={description} onInput={(e) => setDescription((e.target as HTMLTextAreaElement).value)} />
      </div>
      <div class="row" style="gap:14px;align-items:flex-start">
        <div class="field" style="width:160px">
          <label>Priority</label>
          <select class="select" value={priority} onChange={(e) => setPriority((e.target as HTMLSelectElement).value)}>
            {['low', 'normal', 'high', 'urgent'].map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </div>
        <div class="field grow">
          <label>Related files</label>
          <input class="input mono" value={files} onInput={(e) => setFiles((e.target as HTMLInputElement).value)} placeholder="Code/BoatController.cs, Assets/Ships/" />
        </div>
      </div>
    </Modal>
  );
}

export { Empty };
