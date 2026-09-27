import { useState } from 'preact/hooks';
import { api, type Me, type Project, type Reservation } from '../api';
import { ago, Avatar, Empty, Eyebrow, Icon, Loading, Modal, until, useAction, useLoad } from '../lib';

interface CheckResult {
  clear: boolean;
  message: string;
}

export function FilesPage({ project, me }: { project: Project; me: Me }) {
  const reservations = useLoad(() => api.tool<Reservation[]>('file_list_reservations', { project: project.id }), [project.id]);
  const [reserving, setReserving] = useState(false);
  const [check, setCheck] = useState('');
  const [result, setResult] = useState<CheckResult | null>(null);
  const act = useAction();

  const release = async (r: Reservation) => {
    if (await act(() => api.tool('file_release', { project: project.id, reservationIds: [r.id] }), `Released ${r.path}`)) reservations.reload();
  };
  const runCheck = async (e: Event) => {
    e.preventDefault();
    const paths = check.split(/[\n,]/).map((p) => p.trim()).filter(Boolean);
    if (!paths.length) return;
    setResult((await act(() => api.tool<CheckResult>('file_check_conflict', { project: project.id, paths }))) ?? null);
  };

  const groups = new Map<string, Reservation[]>();
  for (const r of reservations.data ?? []) groups.set(r.developerId, [...(groups.get(r.developerId) ?? []), r]);

  return (
    <>
      <div class="page-head">
        <div class="grow">
          <h1>File &amp; asset reservations</h1>
          <p>Advisory locks. They expire on their own and drop when an agent disappears.</p>
        </div>
        <button class="btn primary" onClick={() => setReserving(true)}>
          <Icon name="lock" /> Reserve
        </button>
      </div>
      <div class="split">
        <div>
          {!reservations.data ? (
            <Loading />
          ) : groups.size === 0 ? (
            <div class="panel">
              <Empty icon="lock_open" text="Nothing is reserved. Agents reserve files before major edits." />
            </div>
          ) : (
            [...groups.entries()].map(([developerId, items]) => (
              <div class="panel" key={developerId}>
                <div class="panel-body row" style="padding-bottom:6px">
                  <Avatar id={developerId} name={items[0]!.developerName} size="sm" />
                  <b>{items[0]!.developerName}</b>
                  {developerId === me.developer.id && <span class="pill green">you</span>}
                  <span class="spacer" />
                  <span class="small faint">{items.length} reserved</span>
                </div>
                <div class="table-wrap">
                  <table class="table">
                    <thead>
                      <tr>
                        <th>Path</th>
                        <th>Task / reason</th>
                        <th>Agent</th>
                        <th>Expires</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((r) => (
                        <tr key={r.id}>
                          <td>
                            <div class="row">
                              <Icon name={r.isDirectory ? 'folder' : 'description'} class={r.isDirectory ? 'yellow' : 'muted'} />
                              <span class="mono">{r.path}</span>
                            </div>
                          </td>
                          <td>
                            {r.taskId && <div class="small">#{r.taskId} {r.taskTitle}</div>}
                            <div class="small muted">{r.reason}</div>
                          </td>
                          <td class="small muted">{r.agentLabel ?? 'dashboard'}</td>
                          <td class="small nowrap" title={new Date(r.expiresAt).toLocaleString()}>
                            {until(r.expiresAt)}
                            <div class="tiny faint">since {ago(r.createdAt)}</div>
                          </td>
                          <td>
                            {(r.developerId === me.developer.id || me.developer.role === 'admin') && (
                              <button class="btn ghost" onClick={() => release(r)} title="Release">
                                <Icon name="lock_open" />
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))
          )}
        </div>
        <div class="panel">
          <Eyebrow icon="rule" title="Check before editing" />
          <form class="panel-body col" onSubmit={runCheck}>
            <textarea class="textarea mono" placeholder={'Code/BoatController.cs\nAssets/Shaders/Ocean.shader'} value={check} onInput={(e) => setCheck((e.target as HTMLTextAreaElement).value)} />
            <button class="btn">
              <Icon name="search" /> Check conflicts
            </button>
            {result && (
              <div class={`banner ${result.clear ? 'green' : 'red'}`}>
                <Icon name={result.clear ? 'check_circle' : 'warning'} fill />
                <span class="prose small" style="color:var(--text)">
                  {result.message}
                </span>
              </div>
            )}
          </form>
        </div>
      </div>
      {reserving && <ReserveModal project={project} onClose={() => (setReserving(false), reservations.reload())} />}
    </>
  );
}

function ReserveModal({ project, onClose }: { project: Project; onClose: () => void }) {
  const [paths, setPaths] = useState('');
  const [reason, setReason] = useState('');
  const [hours, setHours] = useState(4);
  const [message, setMessage] = useState<string | null>(null);
  const act = useAction();
  const save = async () => {
    const list = paths.split(/[\n,]/).map((p) => p.trim()).filter(Boolean);
    const result = await act(() => api.tool<{ reserved: unknown[]; conflicts: unknown[]; message: string }>('file_reserve', { project: project.id, paths: list, reason, ttlMinutes: hours * 60 }));
    if (!result) return;
    if (result.conflicts.length) setMessage(result.message);
    else onClose();
  };
  return (
    <Modal
      title="Reserve files"
      icon="lock"
      onClose={onClose}
      footer={
        <>
          <button class="btn ghost" onClick={onClose}>
            Close
          </button>
          <button class="btn primary" disabled={!paths.trim() || !reason.trim()} onClick={save}>
            Reserve
          </button>
        </>
      }
    >
      <div class="field">
        <label>Paths (one per line, end directories with /)</label>
        <textarea class="textarea mono" value={paths} onInput={(e) => setPaths((e.target as HTMLTextAreaElement).value)} placeholder={'Assets/Weather/\nCode/Weather/StormSystem.cs'} autoFocus />
      </div>
      <div class="row" style="gap:14px;align-items:flex-start">
        <div class="field grow">
          <label>Reason</label>
          <input class="input" value={reason} onInput={(e) => setReason((e.target as HTMLInputElement).value)} placeholder="Reworking storm particles" />
        </div>
        <div class="field" style="width:120px">
          <label>Hours</label>
          <input class="input" type="number" min={1} max={72} value={hours} onInput={(e) => setHours(Number((e.target as HTMLInputElement).value) || 4)} />
        </div>
      </div>
      {message && (
        <div class="banner red">
          <Icon name="warning" />
          <span class="prose small" style="color:var(--text)">
            {message}
          </span>
        </div>
      )}
    </Modal>
  );
}
