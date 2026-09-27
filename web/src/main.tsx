import { render } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { Link, navigate, usePath } from './router';
import { api, ApiError, type Me, type Overview, type Project } from './api';
import { Avatar, Icon, Loading, RefreshContext, ToastHost, useLoad, useRealtime, useToast } from './lib';
import { ActivityPage } from './pages/activity';
import { AdminPage } from './pages/admin';
import { AssetsPage } from './pages/assets';
import { DecisionsPage } from './pages/decisions';
import { DevicePage } from './pages/device';
import { FilesPage } from './pages/files';
import { GitPage } from './pages/git';
import { HomePage } from './pages/home';
import { KnowledgePage } from './pages/knowledge';
import { LoginPage } from './pages/login';
import { MessagesPage } from './pages/messages';
import { ProjectPage } from './pages/project';
import { SettingsPage } from './pages/settings';
import { TasksPage } from './pages/tasks';
import { TeamPage } from './pages/team';
import './styles.css';

const TABS = [
  { path: '/', icon: 'space_dashboard', label: 'Overview' },
  { path: '/team', icon: 'groups', label: 'Team' },
  { path: '/tasks', icon: 'view_kanban', label: 'Tasks' },
  { path: '/files', icon: 'lock', label: 'Files' },
  { path: '/assets', icon: 'deployed_code', label: 'Assets' },
  { path: '/git', icon: 'commit', label: 'Git' },
  { path: '/decisions', icon: 'gavel', label: 'Decisions' },
  { path: '/knowledge', icon: 'menu_book', label: 'Knowledge' },
  { path: '/messages', icon: 'forum', label: 'Messages' },
  { path: '/activity', icon: 'timeline', label: 'Activity' },
  { path: '/project', icon: 'sailing', label: 'Project' },
];

// ---------------------------------------------------------------- shell

function Shell({ me }: { me: Me }) {
  const path = usePath();
  const toast = useToast();
  const projects = useLoad(() => api.tool<Project[]>('project_list'), []);
  const [projectId, setProjectId] = useState<string | null>(() => {
    try {
      return localStorage.getItem('collab.project');
    } catch {
      return null;
    }
  });
  const [menu, setMenu] = useState(false);

  useEffect(() => {
    const list = projects.data;
    if (!list?.length) return;
    if (!projectId || !list.some((p) => p.id === projectId)) setProjectId(list[0]!.id);
  }, [projects.data, projectId]);
  useEffect(() => {
    try {
      if (projectId) localStorage.setItem('collab.project', projectId);
    } catch {
      /* private mode */
    }
  }, [projectId]);

  const { tick, live } = useRealtime(projectId, (type, data) => {
    if (type === 'message_received' && data?.toDeveloperId === me.developer.id) toast('info', `Message from ${data.fromName}: ${String(data.body).slice(0, 80)}`);
    if (type === 'build_broken') toast('error', `Build broken: ${data?.description ?? ''}`);
  });
  const overview = useLoad(() => (projectId ? api.get<Overview>(`/api/overview?project=${encodeURIComponent(projectId)}`) : Promise.resolve(undefined)), [projectId, tick]);

  if (projects.loading && !projects.data) return <Loading />;
  const project = projects.data?.find((p) => p.id === projectId) ?? null;
  const isAdmin = me.developer.role === 'admin';
  const online = overview.data?.team.flatMap((t) => t.agents.map((a) => ({ agent: a, dev: t.developer }))) ?? [];

  const logout = async () => {
    await api.post('/api/auth/logout').catch(() => undefined);
    location.href = '/login';
  };

  let page: preact.ComponentChildren;
  if (path === '/settings') page = <SettingsPage me={me} projects={projects.data ?? []} />;
  else if (path === '/admin' && isAdmin) page = <AdminPage projects={projects.data ?? []} reloadProjects={projects.reload} />;
  else if (!project) page = <NoProjects isAdmin={isAdmin} />;
  else if (path === '/team') page = <TeamPage overview={overview.data} />;
  else if (path === '/tasks') page = <TasksPage project={project} me={me} />;
  else if (path === '/files') page = <FilesPage project={project} me={me} />;
  else if (path === '/assets') page = <AssetsPage project={project} />;
  else if (path === '/git') page = <GitPage project={project} />;
  else if (path === '/decisions') page = <DecisionsPage project={project} />;
  else if (path === '/knowledge') page = <KnowledgePage project={project} />;
  else if (path === '/messages') page = <MessagesPage project={project} me={me} overview={overview.data} />;
  else if (path === '/activity') page = <ActivityPage project={project} />;
  else if (path === '/project') page = <ProjectPage project={project} reload={projects.reload} />;
  else page = <HomePage overview={overview.data} error={overview.error} project={project} me={me} />;

  return (
    <RefreshContext.Provider value={tick}>
      <header class="topbar">
        <div class="topbar-main">
          <Link href="/" class="brand">
            <img src="/logo.svg" alt="" />
            <span>
              Collaborator
              <small>s&amp;box team sync</small>
            </span>
          </Link>
          <div class="divider-v" />
          {projects.data && projects.data.length > 0 && (
            <div class="project-switch">
              <select value={projectId ?? ''} onChange={(e) => setProjectId((e.target as HTMLSelectElement).value)} aria-label="Project">
                {projects.data.map((p) => (
                  <option value={p.id} key={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <Icon name="expand_more" />
            </div>
          )}
          {project?.milestone && (
            <div class="milestone ellipsis" title="Current milestone">
              <Icon name="flag" fill />
              <span class="ellipsis">{project.milestone}</span>
            </div>
          )}
          <div class="presence">
            <span class="label">{online.length ? 'Online' : 'Nobody online'}</span>
            <div class="avatar-stack">
              {online.slice(0, 8).map(({ agent, dev }) => (
                <Avatar key={agent.id} id={dev.id} name={dev.displayName} githubLogin={dev.githubLogin} status={agent.status} title={`${agent.label} – ${agent.status}${agent.currentTaskTitle ? `: ${agent.currentTaskTitle}` : ''}`} />
              ))}
            </div>
            <span class={`dot${live ? ' green live' : ''}`} title={live ? 'Live updates connected' : 'Reconnecting…'} style="margin-left:10px" />
          </div>
          <Link href="/messages" class="icon-btn" >
            <Icon name="notifications" />
            {(overview.data?.unreadMessages ?? 0) > 0 && <span class="badge">{overview.data!.unreadMessages}</span>}
          </Link>
          <div style="position:relative">
            <button class="user-chip" onClick={() => setMenu((m) => !m)}>
              <Avatar id={me.developer.id} name={me.developer.displayName} githubLogin={me.developer.githubLogin} size="sm" />
              <span class="small" style="font-weight:600">{me.developer.displayName}</span>
              <Icon name="expand_more" class="muted" />
            </button>
            {menu && (
              <div class="menu" onMouseLeave={() => setMenu(false)}>
                <button onClick={() => (setMenu(false), navigate('/settings'))}>
                  <Icon name="key" /> Connect agents &amp; keys
                </button>
                {isAdmin && (
                  <button onClick={() => (setMenu(false), navigate('/admin'))}>
                    <Icon name="admin_panel_settings" /> Server admin
                  </button>
                )}
                <button onClick={logout}>
                  <Icon name="logout" /> Sign out
                </button>
              </div>
            )}
          </div>
        </div>
        <nav class="tabs">
          {TABS.map((tab) => (
            <Link key={tab.path} href={tab.path} class={`tab${path === tab.path ? ' active' : ''}`}>
              <Icon name={tab.icon} />
              {tab.label}
              {tab.path === '/messages' && (overview.data?.unreadMessages ?? 0) > 0 && <span class="count alert">{overview.data!.unreadMessages}</span>}
              {tab.path === '/files' && (overview.data?.reservations.length ?? 0) > 0 && <span class="count">{overview.data!.reservations.length}</span>}
            </Link>
          ))}
        </nav>
      </header>
      <main class="page">{page}</main>
    </RefreshContext.Provider>
  );
}

function NoProjects({ isAdmin }: { isAdmin: boolean }) {
  return (
    <div class="panel" style="max-width:560px;margin:60px auto">
      <div class="panel-body col" style="align-items:center;text-align:center;padding:36px">
        <Icon name="sailing" style="font-size:40px;color:var(--green)" />
        <h2 style="margin:6px 0 0">No projects yet</h2>
        <p class="muted">{isAdmin ? 'Create the first s&box project and link its GitHub repository.' : 'Ask the server admin to give you access to a project.'}</p>
        {isAdmin && (
          <Link href="/admin" class="btn primary">
            <Icon name="add" /> Create a project
          </Link>
        )}
      </div>
    </div>
  );
}

function App() {
  const path = usePath();
  const me = useLoad(() => api.get<Me>('/api/me').catch((e) => (e instanceof ApiError && e.status === 401 ? null : Promise.reject(e))), [path === '/login']);
  const content = useMemo(() => {
    if (path === '/device') return <DevicePage me={me.data ?? null} loading={me.loading} />;
    if (me.loading && me.data === undefined) return <Loading />;
    if (!me.data || path === '/login') return <LoginPage signedIn={!!me.data} />;
    return <Shell me={me.data} />;
  }, [path, me.data, me.loading]);
  return <ToastHost>{content}</ToastHost>;
}

render(<App />, document.getElementById('app')!);
