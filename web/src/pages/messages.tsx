import { useState } from 'preact/hooks';
import { api, type Me, type Message, type Overview, type Project } from '../api';
import { ago, Avatar, Empty, Eyebrow, Icon, Loading, Pill, useAction, useLoad } from '../lib';

const TYPES = ['info', 'question', 'warning', 'blocker', 'request', 'handoff'];
const TYPE_ICON: Record<string, string> = { info: 'info', question: 'help', warning: 'warning', blocker: 'block', request: 'assignment', handoff: 'swap_horiz' };

export function MessagesPage({ project, me, overview }: { project: Project; me: Me; overview: Overview | undefined }) {
  const messages = useLoad(() => api.get<Message[]>(`/api/messages?project=${encodeURIComponent(project.id)}&limit=100`), [project.id]);
  const act = useAction();
  const [to, setTo] = useState('');
  const [type, setType] = useState('info');
  const [body, setBody] = useState('');
  const teammates = overview?.team.filter((t) => t.developer.id !== me.developer.id) ?? [];

  const send = async (e: Event) => {
    e.preventDefault();
    const ok = to ? await act(() => api.tool('message_send', { project: project.id, to, type, body }), 'Sent') : await act(() => api.tool('message_broadcast', { project: project.id, type, body }), 'Broadcast sent');
    if (ok) {
      setBody('');
      messages.reload();
    }
  };
  const ack = async (m: Message) => {
    if (await act(() => api.tool('message_acknowledge', { messageIds: [m.id] }))) messages.reload();
  };
  const unacked = (messages.data ?? []).filter((m) => !m.ackedAt && m.fromDeveloperId !== me.developer.id);
  if (!messages.data) return <Loading />;

  return (
    <>
      <div class="page-head">
        <div class="grow">
          <h1>Messages</h1>
          <p>Short, structured messages between developers and agents – for things that need attention, not chatter.</p>
        </div>
        {unacked.length > 1 && (
          <button class="btn" onClick={async () => (await act(() => api.tool('message_acknowledge', { messageIds: unacked.map((m) => m.id) }), 'All acknowledged')) && messages.reload()}>
            <Icon name="done_all" /> Acknowledge all
          </button>
        )}
      </div>
      <div class="split">
        <div class="panel">
          {messages.data.length === 0 ? (
            <Empty icon="forum" text="No messages." />
          ) : (
            messages.data.map((m) => {
              const incoming = m.fromDeveloperId !== me.developer.id;
              const pending = incoming && !m.ackedAt;
              return (
                <div class="list-row" key={m.id} style={`align-items:flex-start;${pending ? 'background:rgba(176,226,77,0.04)' : ''}`}>
                  <Avatar id={m.fromDeveloperId} name={m.fromName} size="sm" />
                  <div class="grow">
                    <div class="row wrap">
                      <b>{m.fromName}</b>
                      <span class="small muted">→ {m.broadcast ? 'everyone' : m.toDeveloperId === me.developer.id ? 'you' : m.toDeveloperId}</span>
                      <Pill value={m.type} />
                      {m.taskId && <span class="chip">#{m.taskId}</span>}
                      <span class="spacer" />
                      <span class="tiny faint">{ago(m.createdAt)}</span>
                    </div>
                    {m.subject && <div style="font-weight:600;margin-top:4px">{m.subject}</div>}
                    <div class="prose" style="margin-top:4px;color:var(--text)">
                      {m.body}
                    </div>
                    {m.paths.length > 0 && (
                      <div class="chips">
                        {m.paths.map((p) => (
                          <span class="chip" key={p}>
                            {p}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  {pending && (
                    <button class="btn ghost" title="Acknowledge" onClick={() => ack(m)}>
                      <Icon name="check" />
                    </button>
                  )}
                </div>
              );
            })
          )}
        </div>
        <div class="panel">
          <Eyebrow icon="send" title="Send a message" />
          <form class="panel-body col" style="gap:12px" onSubmit={send}>
            <div class="field">
              <label>To</label>
              <select class="select" value={to} onChange={(e) => setTo((e.target as HTMLSelectElement).value)}>
                <option value="">Everyone (broadcast)</option>
                {teammates.map((t) => (
                  <optgroup label={t.developer.displayName} key={t.developer.id}>
                    <option value={t.developer.id}>{t.developer.displayName} (all their agents)</option>
                    {t.agents.map((a) => (
                      <option value={a.id} key={a.id}>
                        {a.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
            <div class="field">
              <label>Type</label>
              <div class="row wrap">
                {TYPES.map((t) => (
                  <button type="button" key={t} class={`pill ${type === t ? 'green' : 'ghost'}`} style="cursor:pointer;border-width:1px" onClick={() => setType(t)}>
                    <Icon name={TYPE_ICON[t]!} style="font-size:13px" /> {t}
                  </button>
                ))}
              </div>
            </div>
            <div class="field">
              <label>Message</label>
              <textarea class="textarea" maxLength={1000} value={body} onInput={(e) => setBody((e.target as HTMLTextAreaElement).value)} placeholder="I'm rewriting BoatController.cs – please avoid it until #42 is done." />
              <span class="tiny faint" style="text-align:right">{body.length}/1000</span>
            </div>
            <button class="btn primary" disabled={!body.trim()}>
              <Icon name="send" /> Send
            </button>
          </form>
        </div>
      </div>
    </>
  );
}
