import { useState } from 'preact/hooks';
import { api, type Me, type Project } from '../api';
import { ago, Empty, Eyebrow, Icon, Loading, Modal, Secret, useAction, useLoad } from '../lib';

interface AccessKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  projectIds: string[] | null;
  createdVia: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}
interface WebSession {
  id: string;
  userAgent: string | null;
  ip: string | null;
  lastSeenAt: string;
}

const CLIENTS = ['Claude Code', 'Codex CLI', 'Cursor', 'OpenCode'] as const;

function snippet(client: (typeof CLIENTS)[number], origin: string): { file: string; text: string; note: string } {
  const url = `${origin}/mcp`;
  switch (client) {
    case 'Claude Code':
      return {
        file: 'terminal (user scope – nothing is written into the repo)',
        text: `claude mcp add --scope user --transport http collaborator ${url} \\\n  --header "Authorization: Bearer \${COLLAB_TOKEN}"`,
        note: 'Or commit a .mcp.json that uses ${COLLAB_TOKEN} – Claude Code expands environment variables, so the key itself stays out of git.',
      };
    case 'Codex CLI':
      return {
        file: '~/.codex/config.toml',
        text: `[mcp_servers.collaborator]\nurl = "${url}"\nbearer_token_env_var = "COLLAB_TOKEN"`,
        note: 'Codex reads the key from the COLLAB_TOKEN environment variable.',
      };
    case 'Cursor':
      return {
        file: '~/.cursor/mcp.json',
        text: JSON.stringify({ mcpServers: { collaborator: { url: `${url}?profile=core`, headers: { Authorization: 'Bearer ${env:COLLAB_TOKEN}' } } } }, null, 2),
        note: '?profile=core keeps the tool count under Cursor’s limit.',
      };
    case 'OpenCode':
      return {
        file: 'opencode.json',
        text: JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp: { collaborator: { type: 'remote', url, headers: { Authorization: 'Bearer {env:COLLAB_TOKEN}' } } } }, null, 2),
        note: 'OpenCode substitutes {env:COLLAB_TOKEN} at startup.',
      };
  }
}

export function SettingsPage({ me, projects }: { me: Me; projects: Project[] }) {
  const keys = useLoad(() => api.get<AccessKey[]>('/api/keys'), []);
  const sessions = useLoad(() => api.get<WebSession[]>('/api/sessions'), []);
  const [creating, setCreating] = useState(false);
  const [client, setClient] = useState<(typeof CLIENTS)[number]>('Claude Code');
  const act = useAction();
  const s = snippet(client, location.origin);

  const revoke = async (key: AccessKey) => {
    if (!confirm(`Revoke "${key.name}"? Agents using it lose access immediately.`)) return;
    if (await act(() => api.del(`/api/keys/${key.id}`), 'Key revoked')) keys.reload();
  };

  return (
    <>
      <div class="page-head">
        <div class="grow">
          <h1>Connect your agents</h1>
          <p>One access key per device or agent. Keys are shown once, stored hashed, and can be revoked any time.</p>
        </div>
        <button class="btn primary" onClick={() => setCreating(true)}>
          <Icon name="add" /> New access key
        </button>
      </div>
      <div class="split">
        <div class="col" style="gap:16px">
          <div class="panel">
            <Eyebrow icon="cable" title="MCP client setup" />
            <div class="panel-body col" style="gap:12px">
              <div class="seg" style="align-self:flex-start">
                {CLIENTS.map((c) => (
                  <button key={c} class={client === c ? 'on' : ''} onClick={() => setClient(c)}>
                    {c}
                  </button>
                ))}
              </div>
              <div class="small muted">
                1. Create an access key. 2. Put it in the <span class="mono">COLLAB_TOKEN</span> environment variable on that machine. 3. Add the server:
              </div>
              <div class="tiny faint mono">{s.file}</div>
              <Secret value={s.text} />
              <div class="small muted">{s.note}</div>
              <div class="banner yellow">
                <Icon name="shield" />
                <span class="small" style="color:var(--text)">
                  Never paste an access key into a file inside a repository. Keep it in an environment variable or your user-level client config.
                </span>
              </div>
              <div class="small muted">
                Then tell your agent to follow the team workflow – see <span class="mono">clients/AGENTS.md</span>, or use the <span class="mono">start_work</span> MCP prompt.
              </div>
            </div>
          </div>
          <div class="panel">
            <Eyebrow icon="key" title="Your access keys" />
            {!keys.data ? (
              <Loading />
            ) : keys.data.length === 0 ? (
              <Empty icon="key" text="No keys yet." />
            ) : (
              <div class="table-wrap">
                <table class="table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Scopes</th>
                      <th>Last used</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {keys.data.map((k) => (
                      <tr key={k.id} style={k.revokedAt ? 'opacity:.45' : ''}>
                        <td>
                          <div style="font-weight:500">{k.name}</div>
                          <div class="mono tiny faint">
                            {k.prefix}… · {k.createdVia}
                          </div>
                        </td>
                        <td>
                          <div class="row wrap">
                            {k.scopes.map((sc) => (
                              <span class={`pill ${sc === 'read' ? 'blue' : sc === 'admin' ? 'orange' : 'green'}`} key={sc}>
                                {sc}
                              </span>
                            ))}
                            {k.projectIds && <span class="pill ghost">{k.projectIds.join(', ')}</span>}
                          </div>
                        </td>
                        <td class="small muted nowrap">{k.revokedAt ? 'revoked' : k.lastUsedAt ? ago(k.lastUsedAt) : 'never'}</td>
                        <td>
                          {!k.revokedAt && (
                            <button class="btn ghost danger" onClick={() => revoke(k)}>
                              Revoke
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
        <div class="col" style="gap:16px">
          <div class="panel">
            <Eyebrow icon="badge" title="Your account" />
            <div class="panel-body">
              <dl class="kv">
                <dt>Developer id</dt>
                <dd class="mono">{me.developer.id}</dd>
                <dt>GitHub</dt>
                <dd>{me.developer.githubLogin ? `@${me.developer.githubLogin}` : '–'}</dd>
                <dt>Role</dt>
                <dd>{me.developer.role}</dd>
              </dl>
            </div>
          </div>
          <div class="panel">
            <Eyebrow icon="devices" title="Dashboard sessions" />
            {(sessions.data ?? []).map((s) => (
              <div class="list-row" key={s.id}>
                <Icon name="computer" />
                <div class="grow">
                  <div class="small ellipsis">{s.userAgent ?? 'unknown browser'}</div>
                  <div class="tiny faint">
                    {s.ip} · {ago(s.lastSeenAt)}
                  </div>
                </div>
                <button class="btn ghost" title="Sign out this session" onClick={async () => (await act(() => api.del(`/api/sessions/${s.id}`), 'Session ended')) && sessions.reload()}>
                  <Icon name="logout" />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
      {creating && <CreateKey projects={projects} onClose={() => (setCreating(false), keys.reload())} />}
    </>
  );
}

function CreateKey({ projects, onClose }: { projects: Project[]; onClose: () => void }) {
  const [name, setName] = useState('');
  const [readOnly, setReadOnly] = useState(false);
  const [limit, setLimit] = useState<string[]>([]);
  const [days, setDays] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const act = useAction();
  const create = async () => {
    const result = await act(() =>
      api.post<{ token: string }>('/api/keys', { name, scopes: readOnly ? ['read'] : ['write'], projectIds: limit.length ? limit : null, expiresInDays: days ? Number(days) : null }),
    );
    if (result) setToken(result.token);
  };
  return (
    <Modal
      title={token ? 'Your new access key' : 'New access key'}
      icon="key"
      onClose={onClose}
      footer={
        token ? (
          <button class="btn primary" onClick={onClose}>
            I stored it safely
          </button>
        ) : (
          <>
            <button class="btn ghost" onClick={onClose}>
              Cancel
            </button>
            <button class="btn primary" disabled={!name.trim()} onClick={create}>
              Create key
            </button>
          </>
        )
      }
    >
      {token ? (
        <>
          <div class="banner yellow">
            <Icon name="visibility" />
            <span class="small" style="color:var(--text)">
              This is the only time the key is shown. Set it as <span class="mono">COLLAB_TOKEN</span> on the machine that runs the agent.
            </span>
          </div>
          <Secret value={token} />
        </>
      ) : (
        <>
          <div class="field">
            <label>Name</label>
            <input class="input" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} placeholder="desktop – claude code" autoFocus />
          </div>
          <label class="row small" style="cursor:pointer">
            <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly((e.target as HTMLInputElement).checked)} /> Read-only (can see everything, change nothing)
          </label>
          <div class="field">
            <label>Limit to projects (optional)</label>
            <div class="row wrap">
              {projects.map((p) => (
                <button key={p.id} type="button" class={`pill ${limit.includes(p.id) ? 'green' : 'ghost'}`} style="cursor:pointer;border-width:1px" onClick={() => setLimit(limit.includes(p.id) ? limit.filter((x) => x !== p.id) : [...limit, p.id])}>
                  {p.name}
                </button>
              ))}
            </div>
          </div>
          <div class="field" style="width:200px">
            <label>Expires after (days)</label>
            <input class="input" type="number" min={1} value={days} placeholder="never" onInput={(e) => setDays((e.target as HTMLInputElement).value)} />
          </div>
        </>
      )}
    </Modal>
  );
}
