import { useState } from 'preact/hooks';
import { api, type Decision, type Project } from '../api';
import { ago, Empty, Icon, Loading, Modal, Pill, useAction, useLoad } from '../lib';

export function DecisionsPage({ project }: { project: Project }) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<Decision | null>(null);
  const list = useLoad(() => api.tool<Decision[]>('decision_list', { project: project.id, limit: 100, ...(query ? { query } : {}), ...(status ? { status } : {}) }), [project.id, query, status]);
  return (
    <>
      <div class="page-head">
        <div class="grow">
          <h1>Decision log</h1>
          <p>Lasting technical decisions. Agents consult these before touching the affected systems.</p>
        </div>
        <div class="search" style="width:240px">
          <Icon name="search" />
          <input class="input" placeholder="networking, ocean…" value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
        </div>
        <select class="select" style="width:150px" value={status} onChange={(e) => setStatus((e.target as HTMLSelectElement).value)}>
          <option value="">Current</option>
          <option value="superseded">Superseded</option>
          <option value="rejected">Rejected</option>
        </select>
        <button class="btn primary" onClick={() => setCreating(true)}>
          <Icon name="add" /> Record decision
        </button>
      </div>
      {!list.data ? (
        <Loading />
      ) : list.data.length === 0 ? (
        <div class="panel">
          <Empty icon="gavel" text="No decisions recorded yet." />
        </div>
      ) : (
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(380px,1fr));gap:14px">
          {list.data.map((d) => (
            <div class="panel card" style="padding:16px;background:var(--panel)" key={d.id} onClick={() => setOpen(d)}>
              <div class="row">
                <span class="mono faint">D{d.id}</span>
                <b class="grow">{d.title}</b>
                <Pill value={d.status} />
              </div>
              <p class="small" style="color:var(--text-2);margin:8px 0">
                {d.decision.length > 220 ? `${d.decision.slice(0, 220)}…` : d.decision}
              </p>
              <div class="chips">
                {d.affectedSystems.map((s) => (
                  <span class="chip" key={s}>
                    {s}
                  </span>
                ))}
              </div>
              <div class="tiny faint" style="margin-top:8px">
                {d.authorName} · {ago(d.createdAt)}
              </div>
            </div>
          ))}
        </div>
      )}
      {open && (
        <Modal title={`D${open.id} · ${open.title}`} icon="gavel" onClose={() => setOpen(null)} wide>
          <div class="row wrap">
            <Pill value={open.status} />
            {open.supersededBy && <span class="pill ghost">superseded by D{open.supersededBy}</span>}
            {open.affectedSystems.map((s) => (
              <span class="chip" key={s}>
                {s}
              </span>
            ))}
          </div>
          {[
            ['Context', open.context],
            ['Decision', open.decision],
            ['Reasoning', open.reasoning],
          ].map(([label, text]) => (
            <div class="col" style="gap:4px" key={label}>
              <div class="eyebrow" style="padding:0">{label}</div>
              <div class="prose">{text}</div>
            </div>
          ))}
          <div class="small muted">
            {open.authorName} · {new Date(open.createdAt).toLocaleString()}
            {open.taskId ? ` · task #${open.taskId}` : ''}
            {open.commitSha ? ` · ${open.commitSha.slice(0, 7)}` : ''}
          </div>
        </Modal>
      )}
      {creating && <CreateDecision project={project} onClose={() => (setCreating(false), list.reload())} />}
    </>
  );
}

function CreateDecision({ project, onClose }: { project: Project; onClose: () => void }) {
  const [form, setForm] = useState({ title: '', context: '', decision: '', reasoning: '', systems: '' });
  const act = useAction();
  const set = (key: keyof typeof form) => (e: Event) => setForm({ ...form, [key]: (e.target as HTMLInputElement).value });
  const save = async () => {
    const affectedSystems = form.systems.split(',').map((s) => s.trim()).filter(Boolean);
    if (await act(() => api.tool('decision_create', { project: project.id, title: form.title, context: form.context, decision: form.decision, reasoning: form.reasoning, affectedSystems }), 'Decision recorded')) onClose();
  };
  return (
    <Modal
      title="Record a decision"
      icon="gavel"
      onClose={onClose}
      wide
      footer={
        <>
          <button class="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button class="btn primary" disabled={!form.title || !form.context || !form.decision || !form.reasoning} onClick={save}>
            Record
          </button>
        </>
      }
    >
      <div class="field">
        <label>Title</label>
        <input class="input" value={form.title} onInput={set('title')} placeholder="Use one shared OceanSystem" autoFocus />
      </div>
      <div class="field">
        <label>Context</label>
        <textarea class="textarea" value={form.context} onInput={set('context')} />
      </div>
      <div class="field">
        <label>Decision</label>
        <textarea class="textarea" value={form.decision} onInput={set('decision')} />
      </div>
      <div class="field">
        <label>Reasoning</label>
        <textarea class="textarea" value={form.reasoning} onInput={set('reasoning')} />
      </div>
      <div class="field">
        <label>Affected systems (comma separated)</label>
        <input class="input" value={form.systems} onInput={set('systems')} placeholder="ocean, BoatController, networking" />
      </div>
    </Modal>
  );
}
