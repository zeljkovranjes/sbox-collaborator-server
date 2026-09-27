import { useState } from 'preact/hooks';
import { api, type Project } from '../api';
import { ago, Avatar, Empty, Eyebrow, Icon, Loading, Modal, Secret, useAction, useLoad } from '../lib';

interface DevRow { id: string; displayName: string; githubLogin: string | null; role: 'admin' | 'member'; projectIds: string[] | null; createdAt: string; disabled: boolean }
interface JoinKey { id: string; name: string; prefix: string; role: string; githubLogin: string | null; maxUses: number | null; uses: number; createdAt: string; expiresAt: string | null; revokedAt: string | null; usable: boolean }
interface Status { database: string; publicUrl: string; githubToken: boolean; githubOAuth: boolean; webhookSecret: boolean; webhookUrl: string; realtimeSubscribers: number; agentOfflineAfterMinutes: number; reservationGraceMinutes: number }

const Check = ({ ok, label, hint }: { ok: boolean; label: string; hint: string }) => (
  <div class="list-row">
    <Icon name={ok ? 'check_circle' : 'radio_button_unchecked'} fill={ok} class={ok ? 'green' : 'yellow'} />
    <div class="grow">
      <div>{label}</div>
      {!ok && <div class="tiny muted">{hint}</div>}
    </div>
  </div>
);

export function AdminPage({ projects, reloadProjects }: { projects: Project[]; reloadProjects: () => void }) {
  const status = useLoad(() => api.get<Status>('/api/admin/status'), []);
  const devs = useLoad(() => api.get<DevRow[]>('/api/admin/developers'), []);
  const joinKeys = useLoad(() => api.get<JoinKey[]>('/api/admin/join-keys'), []);
  const [inviting, setInviting] = useState(false);
  const [newProject, setNewProject] = useState(false);
  const act = useAction();

  const setRole = async (d: DevRow) => {
    const role = d.role === 'admin' ? 'member' : 'admin';
    if (!confirm(role === 'admin' ? `Make ${d.displayName} an admin? Admins can invite people, manage keys and projects.` : `Make ${d.displayName} a normal member again?`)) return;
    if (await act(() => api.patch(`/api/admin/developers/${d.id}`, { role }), role === 'admin' ? `${d.displayName} is now an admin` : `${d.displayName} is now a member`)) devs.reload();
  };
  const toggle = async (d: DevRow) => {
    if (!confirm(`${d.disabled ? 'Re-enable' : 'Disable'} ${d.displayName}?`)) return;
    if (await act(() => api.patch(`/api/admin/developers/${d.id}`, { disabled: !d.disabled }), 'Updated')) devs.reload();
  };
  const revokeJoin = async (k: JoinKey) => {
    if (await act(() => api.del(`/api/admin/join-keys/${k.id}`), 'Server key revoked')) joinKeys.reload();
  };
  const s = status.data;

  return (
    <>
      <div class="page-head">
        <div class="grow">
          <h1>Server admin</h1>
          <p>Invite teammates with a server key, manage developers and projects.</p>
        </div>
        <button class="btn" onClick={() => setNewProject(true)}>
          <Icon name="add" /> Project
        </button>
        <button class="btn primary" onClick={() => setInviting(true)}>
          <Icon name="person_add" /> Invite teammate
        </button>
      </div>
      <div class="split">
        <div class="col" style="gap:16px">
          <div class="panel">
            <Eyebrow icon="vpn_key" title="Server keys (invites)" aside="the key a new teammate enters before GitHub login" />
            {!joinKeys.data ? (
              <Loading />
            ) : joinKeys.data.length === 0 ? (
              <Empty icon="vpn_key" text="No server keys. Invite a teammate to create one." />
            ) : (
              <div class="table-wrap">
                <table class="table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>For</th>
                      <th>Uses</th>
                      <th>Expires</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {joinKeys.data.map((k) => (
                      <tr key={k.id} style={k.usable ? '' : 'opacity:.45'}>
                        <td>
                          <div>{k.name}</div>
                          <div class="mono tiny faint">{k.prefix}…</div>
                        </td>
                        <td class="small">{k.githubLogin ? `@${k.githubLogin}` : 'anyone'} · {k.role}</td>
                        <td class="small">
                          {k.uses}/{k.maxUses ?? '∞'}
                        </td>
                        <td class="small muted">{k.revokedAt ? 'revoked' : k.expiresAt ? new Date(k.expiresAt).toLocaleDateString() : 'never'}</td>
                        <td>
                          {k.usable && (
                            <button class="btn ghost danger" onClick={() => revokeJoin(k)}>
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
          <div class="panel">
            <Eyebrow icon="group" title="Developers" />
            {!devs.data ? (
              <Loading />
            ) : (
              devs.data.map((d) => (
                <div class="list-row" key={d.id} style={d.disabled ? 'opacity:.5' : ''}>
                  <Avatar id={d.id} name={d.displayName} githubLogin={d.githubLogin} size="sm" />
                  <div class="grow">
                    <div style="font-weight:500">
                      {d.displayName} <span class="faint small mono">{d.id}</span>
                    </div>
                    <div class="tiny muted">
                      {d.githubLogin ? `@${d.githubLogin}` : 'no GitHub login'} · joined {ago(d.createdAt)} {d.projectIds ? `· ${d.projectIds.join(', ')}` : '· all projects'}
                    </div>
                  </div>
                  <span class={`pill ${d.role === 'admin' ? 'orange' : 'ghost'}`}>{d.role}</span>
                  <button class="btn ghost" onClick={() => setRole(d)} title={d.role === 'admin' ? 'Remove admin rights' : 'Give admin rights'}>
                    {d.role === 'admin' ? 'Make member' : 'Make admin'}
                  </button>
                  <button class="btn ghost" onClick={() => toggle(d)}>
                    {d.disabled ? 'Enable' : 'Disable'}
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
        <div class="col" style="gap:16px">
          <div class="panel">
            <Eyebrow icon="monitor_heart" title="Server health" />
            {!s ? (
              <Loading />
            ) : (
              <>
                <Check ok={s.publicUrl.startsWith('https://')} label={`HTTPS · ${s.publicUrl}`} hint="Put the server behind a TLS reverse proxy (docs/deployment.md)." />
                <Check ok={s.githubOAuth} label="GitHub login" hint="Set GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET." />
                <Check ok={s.githubToken} label="GitHub API token" hint="Set GITHUB_TOKEN (fine-grained, read-only contents + issues) for commits, PRs and issues." />
                <Check ok={s.webhookSecret} label="GitHub webhooks" hint={`Set GITHUB_WEBHOOK_SECRET and add ${s.webhookUrl} to the repository.`} />
                <div class="panel-body small muted">
                  Database: {s.database} · {s.realtimeSubscribers} live subscribers · agents go offline after {s.agentOfflineAfterMinutes}m, reservations drop {s.reservationGraceMinutes}m later.
                </div>
              </>
            )}
          </div>
          <div class="panel">
            <Eyebrow icon="sailing" title="Projects" />
            {projects.map((p) => (
              <div class="list-row" key={p.id}>
                <Icon name={p.kind === 'library' ? 'extension' : 'sports_esports'} />
                <div class="grow">
                  <div>{p.name}</div>
                  <div class="tiny muted mono">
                    {p.id} {p.repos.length ? `· ${p.repos.map((r) => r.fullName).join(', ')}` : ''}
                  </div>
                </div>
              </div>
            ))}
            {projects.length === 0 && <Empty icon="sailing" text="No projects yet." />}
          </div>
        </div>
      </div>
      {inviting && <InviteModal projects={projects} onClose={() => (setInviting(false), joinKeys.reload())} />}
      {newProject && <ProjectModal onClose={() => (setNewProject(false), reloadProjects())} />}
    </>
  );
}

function InviteModal({ projects, onClose }: { projects: Project[]; onClose: () => void }) {
  const [name, setName] = useState('');
  const [github, setGithub] = useState('');
  const [days, setDays] = useState('7');
  const [admin, setAdmin] = useState(false);
  const [limit, setLimit] = useState<string[]>([]);
  const [token, setToken] = useState<string | null>(null);
  const act = useAction();
  const create = async () => {
    const result = await act(() =>
      api.post<{ token: string }>('/api/admin/join-keys', { name, githubLogin: github.trim() || null, maxUses: 1, expiresInDays: days ? Number(days) : null, role: admin ? 'admin' : 'member', projectIds: limit.length ? limit : null }),
    );
    if (result) setToken(result.token);
  };
  return (
    <Modal
      title={token ? 'Send this server key' : 'Invite a teammate'}
      icon="person_add"
      onClose={onClose}
      footer={
        token ? (
          <button class="btn primary" onClick={onClose}>
            Done
          </button>
        ) : (
          <>
            <button class="btn ghost" onClick={onClose}>
              Cancel
            </button>
            <button class="btn primary" disabled={!name.trim()} onClick={create}>
              Create server key
            </button>
          </>
        )
      }
    >
      {token ? (
        <>
          <p class="muted" style="margin:0">
            Send it privately (not in a repo or a public channel). Your teammate opens the Collaborator panel in s&amp;box – or <span class="mono">{location.origin}/login</span> – enters the server address, this key, then signs in with GitHub.
          </p>
          <div class="field">
            <label>Server address</label>
            <Secret value={location.origin} />
          </div>
          <div class="field">
            <label>Server key (single use, shown once)</label>
            <Secret value={token} />
          </div>
        </>
      ) : (
        <>
          <div class="field">
            <label>Label</label>
            <input class="input" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} placeholder="for Alex" autoFocus />
          </div>
          <div class="row" style="gap:12px;align-items:flex-start">
            <div class="field grow">
              <label>Only for GitHub user (recommended)</label>
              <input class="input" value={github} onInput={(e) => setGithub((e.target as HTMLInputElement).value)} placeholder="their-github-login" />
            </div>
            <div class="field" style="width:130px">
              <label>Valid for days</label>
              <input class="input" type="number" min={1} value={days} onInput={(e) => setDays((e.target as HTMLInputElement).value)} />
            </div>
          </div>
          <div class="field">
            <label>Project access</label>
            <div class="row wrap">
              <span class="small muted">{limit.length ? 'Only:' : 'All projects (click to limit):'}</span>
              {projects.map((p) => (
                <button key={p.id} type="button" class={`pill ${limit.includes(p.id) ? 'green' : 'ghost'}`} style="cursor:pointer;border-width:1px" onClick={() => setLimit(limit.includes(p.id) ? limit.filter((x) => x !== p.id) : [...limit, p.id])}>
                  {p.name}
                </button>
              ))}
            </div>
          </div>
          <label class="row small" style="cursor:pointer">
            <input type="checkbox" checked={admin} onChange={(e) => setAdmin((e.target as HTMLInputElement).checked)} /> Make them an admin
          </label>
        </>
      )}
    </Modal>
  );
}

function ProjectModal({ onClose }: { onClose: () => void }) {
  const [form, setForm] = useState({ id: '', name: '', kind: 'game', repo: '', branch: 'main', ident: '' });
  const act = useAction();
  const set = (key: keyof typeof form) => (e: Event) => setForm({ ...form, [key]: (e.target as HTMLInputElement).value });
  const create = async () => {
    const ok = await act(
      () => api.tool('project_create', { id: form.id.trim(), name: form.name.trim(), kind: form.kind, repos: form.repo.trim() ? [form.repo.trim()] : [], defaultBranch: form.branch.trim() || 'main', ...(form.ident.trim() ? { packageIdent: form.ident.trim() } : {}) }),
      'Project created',
    );
    if (ok) onClose();
  };
  return (
    <Modal
      title="New project"
      icon="sailing"
      onClose={onClose}
      footer={
        <>
          <button class="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button class="btn primary" disabled={!form.id || !form.name} onClick={create}>
            Create
          </button>
        </>
      }
    >
      <div class="row" style="gap:12px;align-items:flex-start">
        <div class="field grow">
          <label>Name</label>
          <input class="input" value={form.name} onInput={(e) => setForm({ ...form, name: (e.target as HTMLInputElement).value, id: form.id || (e.target as HTMLInputElement).value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') })} placeholder="Sailing" autoFocus />
        </div>
        <div class="field" style="width:180px">
          <label>Id</label>
          <input class="input mono" value={form.id} onInput={set('id')} />
        </div>
      </div>
      <div class="row" style="gap:12px;align-items:flex-start">
        <div class="field" style="width:150px">
          <label>Type</label>
          <select class="select" value={form.kind} onChange={set('kind')}>
            <option value="game">game</option>
            <option value="library">library</option>
            <option value="tool">tool</option>
          </select>
        </div>
        <div class="field grow">
          <label>GitHub repository</label>
          <input class="input mono" value={form.repo} onInput={set('repo')} placeholder="owner/sailing" />
        </div>
      </div>
      <div class="row" style="gap:12px;align-items:flex-start">
        <div class="field grow">
          <label>Package ident</label>
          <input class="input mono" value={form.ident} onInput={set('ident')} placeholder="myorg.sailing" />
        </div>
        <div class="field" style="width:150px">
          <label>Default branch</label>
          <input class="input mono" value={form.branch} onInput={set('branch')} />
        </div>
      </div>
    </Modal>
  );
}
