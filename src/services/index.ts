import { AccountService } from '../auth/accounts.js';
import { DeviceAuthService, SessionService } from '../auth/sessions.js';
import type { Config } from '../config.js';
import type { DatabaseHandle } from '../db/index.js';
import { EventBus } from '../events/bus.js';
import { log } from '../lib/log.js';
import { KeyedMutex } from '../lib/mutex.js';
import { systemClock, type Clock } from '../lib/time.js';
import { ActivityService } from './activity.js';
import { AgentService } from './agents.js';
import { AssetService } from './assets.js';
import { ChangeService } from './changes.js';
import type { Actor, Deps } from './context.js';
import { DecisionService } from './decisions.js';
import { Directory } from './directory.js';
import { GitService } from './git.js';
import { GitHubClient } from './github.js';
import { KnowledgeService } from './knowledge.js';
import { MessageService } from './messages.js';
import { ProjectService } from './projects.js';
import { ReservationService } from './reservations.js';
import { SyncService } from './sync.js';
import { SummaryService } from './summary.js';
import { DiscordNotifier } from './notifications.js';
import { TaskService } from './tasks.js';
import { TestService } from './tests.js';
import { WebhookService } from './webhooks.js';

export type Services = ReturnType<typeof createServices>;

export function createServices(options: { config: Config; database: DatabaseHandle; clock?: Clock; github?: GitHubClient; bus?: EventBus; fetch?: typeof fetch }) {
  const deps: Deps = {
    db: options.database.db,
    database: options.database,
    config: options.config,
    bus: options.bus ?? new EventBus(),
    clock: options.clock ?? systemClock,
    locks: new KeyedMutex(),
  };
  const github = options.github ?? new GitHubClient(options.config.github.token, options.config.github.apiUrl);
  const directory = new Directory(deps);
  const activity = new ActivityService(deps, directory);
  const projects = new ProjectService(deps, activity);
  const agents = new AgentService(deps, directory, activity, projects);
  const tasks = new TaskService(deps, directory, activity, projects);
  const reservations = new ReservationService(deps, directory, activity, projects);
  const messages = new MessageService(deps, directory, activity, projects);
  const decisions = new DecisionService(deps, directory, activity, projects);
  const knowledge = new KnowledgeService(deps, directory, activity);
  const changes = new ChangeService(deps, directory, activity, projects);
  const tests = new TestService(deps, directory, activity, projects);
  const assets = new AssetService(deps, directory, activity, projects, reservations);
  const git = new GitService(deps, directory, activity, projects, agents, tasks, tests, github);
  const webhooks = new WebhookService(deps, directory, activity, projects, agents, tasks, reservations, assets, git, messages);
  const sync = new SyncService(deps, directory, { activity, agents, changes, decisions, git, knowledge, messages, projects, reservations, tasks, tests });
  const summary = new SummaryService(deps, directory, activity, projects, reservations, assets);
  const discord = new DiscordNotifier(deps, directory, projects, options.fetch ?? fetch);
  const accounts = new AccountService(deps, directory);
  const sessions = new SessionService(deps, directory);
  const device = new DeviceAuthService(deps, accounts);

  // Cross-service hooks (kept as callbacks so services stay independent).
  const quiet = (what: string) => (error: unknown) => log.warn(`${what} failed`, { error: (error as Error).message });
  tasks.hooks = {
    notify: (actor, projectId, to, type, body, taskId) =>
      messages
        .send(actor, { project: projectId, to, type, body, taskId })
        .then(() => undefined)
        .catch(quiet('task notification')),
    releaseTaskReservations: (actor, projectId, taskId, reason) => reservations.releaseForTask(actor, projectId, taskId, reason),
    setAgentTask: async (agentId, taskId, status) => {
      await deps.db
        .updateTable('agents')
        .set({ currentTaskId: taskId, ...(status ? { status } : {}), lastHeartbeatAt: deps.clock.now() })
        .where('id', '=', agentId)
        .execute();
      const row = await deps.db.selectFrom('agents').selectAll().where('id', '=', agentId).executeTakeFirst();
      if (row) {
        const [view] = await agents.view([row]);
        deps.bus.emit({ type: 'agent_status_changed', projectId: row.projectId, at: new Date(deps.clock.now()).toISOString(), actor: { developerId: row.developerId, agentId }, data: view });
      }
    },
  };
  reservations.hooks = {
    warn: (actor, projectId, to, body, paths, taskId) =>
      messages
        .send(actor, { project: projectId, to, type: 'warning', body, paths, ...(taskId ? { taskId } : {}) })
        .then(() => undefined)
        .catch(quiet('reservation warning')),
  };
  tests.hooks = {
    warnTeam: (actor: Actor, projectId, body) =>
      messages
        .send(actor, { project: projectId, type: 'warning', body })
        .then(() => undefined)
        .catch(quiet('broken build warning')),
  };

  return { deps, github, directory, activity, projects, agents, tasks, reservations, messages, decisions, knowledge, changes, tests, assets, git, webhooks, sync, summary, discord, accounts, sessions, device };
}
