import { compact } from '../lib/json.js';
import { overlap, pathKey } from '../lib/paths.js';
import { matchScore, recency, tokenSet, truncate } from '../lib/relevance.js';
import { ago, iso } from '../lib/time.js';
import type { ActivityService } from './activity.js';
import type { AgentService } from './agents.js';
import type { ChangeService, Change } from './changes.js';
import { canAccessProject, requireProjectAccess, type Actor, type Deps } from './context.js';
import type { DecisionService } from './decisions.js';
import type { Directory } from './directory.js';
import type { GitService } from './git.js';
import type { KnowledgeService } from './knowledge.js';
import type { MessageService } from './messages.js';
import type { ProjectService } from './projects.js';
import type { Reservation, ReservationService } from './reservations.js';
import type { Task, TaskService } from './tasks.js';
import type { TestService } from './tests.js';

export interface Blocker {
  kind: 'task' | 'message' | 'test';
  title: string;
  detail: string;
  at: string;
  refId: string;
}

const DAY = 86_400_000;
const NOTICE_INTERVAL = 30_000;

/** Builds the compact "what do I need to know" packets: agent sync, dashboard home, notices. */
export class SyncService {
  #lastNotice = new Map<string, number>();

  constructor(
    private readonly deps: Deps,
    private readonly directory: Directory,
    private readonly services: {
      activity: ActivityService;
      agents: AgentService;
      changes: ChangeService;
      decisions: DecisionService;
      git: GitService;
      knowledge: KnowledgeService;
      messages: MessageService;
      projects: ProjectService;
      reservations: ReservationService;
      tasks: TaskService;
      tests: TestService;
    },
  ) {}

  async #blockers(actor: Actor, projectId: string, tasks: Task[]): Promise<Blocker[]> {
    const out: Blocker[] = [];
    for (const task of tasks.filter((t) => t.status === 'blocked')) {
      out.push({ kind: 'task', title: `#${task.id} ${task.title}`, detail: `${task.ownerName ?? 'unowned'}: ${task.blockedReason ?? 'blocked'}`, at: task.updatedAt, refId: String(task.id) });
    }
    for (const run of await this.services.tests.latestPerBranch(projectId)) {
      if (run.status === 'failed' || run.status === 'error') {
        out.push({
          kind: 'test',
          title: `${run.branch ?? 'build'} is failing${run.commitSha ? ` at ${run.commitSha.slice(0, 7)}` : ''}`,
          detail: `${run.description} (${run.developerName})${run.errors[0] ? ` – ${truncate(run.errors[0], 160)}` : ''}`,
          at: run.finishedAt ?? run.startedAt,
          refId: run.id,
        });
      }
    }
    const blockerMessages = await this.deps.db
      .selectFrom('messages')
      .selectAll()
      .where('projectId', '=', projectId)
      .where('type', '=', 'blocker')
      .where('createdAt', '>', this.deps.clock.now() - 3 * DAY)
      .orderBy('createdAt', 'desc')
      .limit(5)
      .execute();
    for (const message of blockerMessages) {
      if (message.toDeveloperId && message.toDeveloperId !== actor.developerId && message.fromDeveloperId !== actor.developerId) continue;
      out.push({ kind: 'message', title: `blocker from ${await this.directory.name(message.fromDeveloperId)}`, detail: truncate(message.body, 200), at: iso(message.createdAt)!, refId: String(message.id) });
    }
    return out.sort((a, b) => b.at.localeCompare(a.at));
  }

  /** Dashboard / editor home packet. */
  async overview(actor: Actor, projectId: string) {
    requireProjectAccess(actor, projectId);
    const project = await this.services.projects.get(actor, projectId);
    const [agents, reservations, tasks, commits, changes, activity, unread, tests, developers] = await Promise.all([
      this.services.agents.listActive(actor, projectId),
      this.services.reservations.list(actor, projectId),
      this.services.tasks.list(actor, projectId, { status: ['claimed', 'in_progress', 'blocked', 'review'], limit: 50 }),
      this.services.git.recentCommits(actor, projectId, { limit: 10 }).catch(() => []),
      this.services.changes.recent(actor, projectId, { limit: 8, includeStarted: true }),
      this.services.activity.recent(projectId, { limit: 40 }),
      this.services.messages.unreadSummary(actor, [projectId]),
      this.services.tests.recent(actor, projectId, { limit: 1 }),
      this.directory.all(),
    ]);
    const team = developers
      .filter((d) => !d.disabled && (d.projectIds === null || d.projectIds.includes(projectId)))
      .map((developer) => {
        const mine = agents.filter((a) => a.developerId === developer.id);
        return { developer: { id: developer.id, displayName: developer.displayName, githubLogin: developer.githubLogin, role: developer.role, online: mine.length > 0 }, agents: mine };
      })
      .sort((a, b) => Number(b.developer.online) - Number(a.developer.online) || a.developer.displayName.localeCompare(b.developer.displayName));
    const me = team.find((t) => t.developer.id === actor.developerId)?.developer ?? { id: actor.developerId, displayName: actor.displayName, githubLogin: null, role: actor.role, online: true };
    return {
      project,
      me,
      team,
      reservations,
      tasksInProgress: tasks.filter((t) => t.status !== 'blocked'),
      blockers: await this.#blockers(actor, projectId, tasks),
      recentCommits: commits,
      recentChanges: changes,
      activity,
      unreadMessages: unread.count,
      lastTest: tests[0] ?? null,
    };
  }

  /** The packet an agent reads before starting work. Compact, relevance-ranked, time-compacted. */
  async context(actor: Actor, projectId: string, options: { focus?: string; paths?: string[] } = {}) {
    requireProjectAccess(actor, projectId);
    const now = this.deps.clock.now();
    const agent = await this.services.agents.resolve(actor, projectId);
    const since = agent?.lastSyncAt ?? now - 3 * DAY;
    const focusPaths = (options.paths ?? []).flatMap((p) => {
      try {
        return [pathKey(p)];
      } catch {
        return [];
      }
    });
    const focus = tokenSet(options.focus, ...(options.paths ?? []));

    const project = await this.services.projects.get(actor, projectId);
    const [agents, allTasks, reservations, commits, changes, decisions, knowledge, unread, builds] = await Promise.all([
      this.services.agents.listActive(actor, projectId),
      this.services.tasks.list(actor, projectId, { limit: 200 }),
      this.services.reservations.list(actor, projectId),
      this.services.git.recentCommits(actor, projectId, { limit: 40, since: Math.min(since, now - 2 * DAY) }).catch(() => []),
      this.services.changes.recent(actor, projectId, { limit: 40, since: Math.min(since, now - 7 * DAY), includeStarted: true }),
      this.services.decisions.list(actor, projectId, { limit: 200 }),
      options.focus || options.paths?.length ? this.services.knowledge.search(actor, { project: projectId, query: [options.focus, ...(options.paths ?? [])].join(' '), limit: 5 }) : this.services.knowledge.search(actor, { project: projectId, limit: 3 }),
      this.services.messages.unread(actor, [projectId], { markRead: false, limit: 10 }),
      this.services.tests.latestPerBranch(projectId),
    ]);

    const relevantPath = (paths: string[]) => focusPaths.some((f) => paths.some((p) => overlap(f, pathKey(p)) !== null));
    const taskScore = (t: Task) => matchScore(focus, tokenSet(t.title, t.description, t.relatedFiles.join(' '))) + (relevantPath(t.relatedFiles) ? 3 : 0);

    const mine = allTasks.filter((t) => t.ownerId === actor.developerId && t.status !== 'done');
    const othersActive = allTasks.filter((t) => t.ownerId && t.ownerId !== actor.developerId && ['claimed', 'in_progress', 'blocked', 'review'].includes(t.status));
    const available = allTasks
      .filter((t) => t.status === 'available')
      .map((t) => ({ t, s: taskScore(t) + ({ urgent: 3, high: 2, normal: 1, low: 0 }[t.priority] ?? 0) * 0.5 }))
      .sort((a, b) => b.s - a.s)
      .map((x) => x.t);

    const resRelevant = (r: Reservation) => focusPaths.some((f) => overlap(f, pathKey(r.path)) !== null) || matchScore(focus, tokenSet(r.path, r.reason, r.taskTitle)) > 0;
    const othersReservations = reservations.filter((r) => r.developerId !== actor.developerId).sort((a, b) => Number(resRelevant(b)) - Number(resRelevant(a)));
    const myReservations = reservations.filter((r) => r.developerId === actor.developerId);

    const changeWeight = (c: Change) =>
      (c.breakingChanges.length || c.apisRemoved.length || c.apisRenamed.length ? 5 : 0) +
      (c.apisAdded.length ? 1 : 0) +
      matchScore(focus, tokenSet(c.summary, c.files.join(' '), c.apisAdded.join(' '), c.apisRemoved.join(' '))) * 2 +
      (relevantPath(c.files) ? 3 : 0) +
      recency(Date.parse(c.completedAt ?? c.startedAt), now, 2 * DAY) * 2;
    const otherChanges = changes.filter((c) => c.developerId !== actor.developerId);
    const rankedChanges = otherChanges.filter((c) => c.status === 'completed').sort((a, b) => changeWeight(b) - changeWeight(a));
    const startedChanges = otherChanges.filter((c) => c.status === 'started');

    const decisionRows = await this.deps.db.selectFrom('decisions').selectAll().where('projectId', '=', projectId).where('status', '=', 'accepted').execute();
    const focusText = [options.focus, ...(options.paths ?? [])].filter(Boolean).join(' ');
    const rankedDecisionIds = focusText
      ? this.services.decisions.rank(decisionRows, focusText, now).filter((x) => x.score > 0).slice(0, 5).map((x) => x.row.id)
      : decisionRows.sort((a, b) => b.createdAt - a.createdAt).slice(0, 5).map((r) => r.id);
    const relevantDecisions = rankedDecisionIds.map((id) => decisions.find((d) => d.id === id)).filter((d) => !!d);

    const newCommits = commits.filter((c) => Date.parse(c.at) >= since);
    const blockers = await this.#blockers(actor, projectId, allTasks);
    if (agent) await this.services.agents.markSynced(agent.id);

    return {
      generatedAt: iso(now)!,
      since: iso(since)!,
      you: { developer: actor.displayName, agentId: agent?.id ?? null, registered: !!agent, currentTaskId: agent?.currentTaskId ?? null },
      project: {
        id: project.id,
        name: project.name,
        kind: project.kind,
        packageIdent: project.packageIdent,
        defaultBranch: project.defaultBranch,
        repos: project.repos.map((r) => r.fullName),
        milestone: project.milestone,
        summary: truncate(project.summary, 1500),
        conventions: truncate(project.conventions, 1500),
        importantDirs: project.importantDirs.slice(0, 15),
      },
      team: agents.filter((a) => a.id !== agent?.id).map((a) => ({ who: a.developerName, agent: a.label, client: a.clientType, status: a.status, note: a.statusNote, task: a.currentTaskId ? `#${a.currentTaskId} ${a.currentTaskTitle ?? ''}`.trim() : null, branch: a.branch, files: a.files.slice(0, 8), lastSeen: ago(Date.parse(a.lastHeartbeatAt), now) })),
      myTasks: mine.slice(0, 10),
      othersTasks: othersActive.slice(0, 12),
      availableTasks: available.slice(0, 8),
      moreAvailableTasks: Math.max(0, available.length - 8),
      reservations: { others: othersReservations.slice(0, 20), othersTotal: othersReservations.length, mine: myReservations.slice(0, 20) },
      recentCommits: (newCommits.length ? newCommits : commits).slice(0, 8),
      olderCommitsOmitted: Math.max(0, (newCommits.length ? newCommits : commits).length - 8),
      changes: { completed: rankedChanges.slice(0, 6), completedOmitted: Math.max(0, rankedChanges.length - 6), inProgress: startedChanges.slice(0, 5) },
      decisions: relevantDecisions,
      decisionsTotal: decisionRows.length,
      knowledge,
      unreadMessages: unread,
      blockers,
      buildStatus: builds.slice(0, 5),
    };
  }

  /** Renders the sync packet as compact Markdown for LLM context windows. */
  renderContext(packet: Awaited<ReturnType<SyncService['context']>>): string {
    const now = Date.parse(packet.generatedAt);
    const lines: string[] = [];
    const p = packet.project;
    lines.push(`# ${p.name} (${p.kind}${p.packageIdent ? `, ${p.packageIdent}` : ''}) – synced ${packet.generatedAt}`);
    if (!packet.you.registered) lines.push('> You are not registered: call agent_register first so teammates can see you.');
    if (p.milestone) lines.push(`Milestone: ${p.milestone}`);
    if (p.repos.length) lines.push(`Repos: ${p.repos.join(', ')} (default branch ${p.defaultBranch})`);
    if (p.summary) lines.push('', '## Project', p.summary);
    if (p.conventions) lines.push('', '## Conventions', p.conventions);
    if (p.importantDirs.length) lines.push('', '## Important directories', ...p.importantDirs.map((d) => `- ${d.path} – ${d.description}`));

    if (packet.blockers.length) {
      lines.push('', '## ⚠ Blockers');
      for (const b of packet.blockers.slice(0, 8)) lines.push(`- [${b.kind}] ${b.title}: ${b.detail}`);
    }
    if (packet.unreadMessages.length) {
      lines.push('', `## Unread messages (${packet.unreadMessages.length}) – acknowledge with message_acknowledge`);
      for (const m of packet.unreadMessages) lines.push(`- (${m.id}) ${m.type.toUpperCase()} from ${m.fromName}${m.broadcast ? ' to all' : ''}, ${ago(Date.parse(m.createdAt), now)}: ${m.body}`);
    }

    lines.push('', '## Team right now');
    if (!packet.team.length) lines.push('- Nobody else is online.');
    for (const a of packet.team) {
      lines.push(`- ${a.agent} [${a.status}]${a.task ? ` on ${a.task}` : ''}${a.branch ? ` @${a.branch}` : ''}${a.note ? ` – ${a.note}` : ''}${a.files.length ? ` · editing ${a.files.join(', ')}` : ''} (seen ${a.lastSeen})`);
    }

    const r = packet.reservations;
    lines.push('', `## Reserved by others (${r.othersTotal}) – do not edit without coordinating`);
    if (!r.others.length) lines.push('- none');
    for (const res of r.others) lines.push(`- ${res.path} → ${res.developerName}${res.taskId ? ` (#${res.taskId})` : ''}: ${res.reason}, until ${res.expiresAt}`);
    if (r.mine.length) lines.push(`Your reservations: ${r.mine.map((x) => x.path).join(', ')}`);

    const taskLine = (t: Task) =>
      `- #${t.id} [${t.status}${t.priority !== 'normal' ? `, ${t.priority}` : ''}] ${t.title}${t.ownerName ? ` – ${t.ownerName}` : ''}${t.branch ? ` @${t.branch}` : ''}${t.stale ? ' (owner offline)' : ''}${t.blockedReason ? ` – blocked: ${t.blockedReason}` : ''}`;
    if (packet.myTasks.length) lines.push('', '## Your tasks', ...packet.myTasks.map(taskLine));
    if (packet.othersTasks.length) lines.push('', '## Teammates are working on', ...packet.othersTasks.map(taskLine));
    lines.push('', `## Available tasks${packet.moreAvailableTasks ? ` (top ${packet.availableTasks.length}, ${packet.moreAvailableTasks} more)` : ''}`);
    if (!packet.availableTasks.length) lines.push('- none');
    lines.push(...packet.availableTasks.map(taskLine));

    const c = packet.changes;
    if (c.completed.length || c.inProgress.length) {
      lines.push('', `## Changes by teammates since ${packet.since}`);
      for (const ch of c.completed) {
        lines.push(`- ${ch.developerName}: ${ch.summary}${ch.commitSha ? ` (${ch.commitSha.slice(0, 7)})` : ''}${ch.taskId ? ` #${ch.taskId}` : ''}, ${ago(Date.parse(ch.completedAt ?? ch.startedAt), now)}`);
        if (ch.files.length) lines.push(`  files: ${ch.files.slice(0, 8).join(', ')}${ch.files.length > 8 ? ` +${ch.files.length - 8}` : ''}`);
        const api = [...ch.apisAdded.map((a) => `+${a}`), ...ch.apisRemoved.map((a) => `-${a}`), ...ch.apisRenamed.map((x) => `${x.from} → ${x.to}`)];
        if (api.length) lines.push(`  API: ${api.join(', ')}`);
        if (ch.breakingChanges.length) lines.push(`  BREAKING: ${ch.breakingChanges.join('; ')}`);
        if (ch.behaviorChanges.length) lines.push(`  behavior: ${ch.behaviorChanges.join('; ')}`);
        if (ch.knownIssues.length) lines.push(`  known issues: ${ch.knownIssues.join('; ')}`);
      }
      if (c.completedOmitted) lines.push(`- …${c.completedOmitted} older/less relevant change(s): project_get_recent_changes`);
      for (const ch of c.inProgress) lines.push(`- in progress: ${ch.developerName} – ${ch.summary}${ch.files.length ? ` (${ch.files.slice(0, 5).join(', ')})` : ''}`);
    }

    if (packet.recentCommits.length) {
      lines.push('', '## Recent commits');
      for (const cm of packet.recentCommits) lines.push(`- ${cm.shortSha} ${cm.branch ?? ''} ${truncate(cm.message.split('\n')[0], 90)} – ${cm.authorLogin ?? cm.authorName ?? '?'}, ${ago(Date.parse(cm.at), now)}${cm.taskId ? ` #${cm.taskId}` : ''}`);
      if (packet.olderCommitsOmitted) lines.push(`- …${packet.olderCommitsOmitted} more: git_get_recent_commits`);
    }
    if (packet.buildStatus.length) {
      lines.push('', '## Build/test status');
      for (const b of packet.buildStatus) lines.push(`- ${b.branch ?? '(no branch)'}: ${b.status.toUpperCase()} – ${b.description}${b.commitSha ? ` @${b.commitSha.slice(0, 7)}` : ''} (${b.developerName})`);
    }
    if (packet.decisions.length) {
      lines.push('', `## Relevant decisions (${packet.decisions.length} of ${packet.decisionsTotal}) – follow these`);
      for (const d of packet.decisions) lines.push(`- D${d.id} ${d.title}: ${truncate(d.decision, 300)}${d.affectedSystems.length ? ` [${d.affectedSystems.join(', ')}]` : ''}`);
    }
    if (packet.knowledge.length) {
      lines.push('', '## Team knowledge');
      for (const k of packet.knowledge) lines.push(`- K${k.id} ${k.title}: ${truncate(k.body, 240)}${k.tags.length ? ` [${k.tags.join(', ')}]` : ''}`);
    }
    return lines.join('\n');
  }

  /**
   * Short nudges appended to tool results: unread urgent messages, breaking changes and broken
   * builds from teammates since the agent last looked. Throttled, and each thing is said once.
   */
  async notices(actor: Actor): Promise<string[]> {
    if (!actor.agentId) return [];
    const now = this.deps.clock.now();
    if (now - (this.#lastNotice.get(actor.agentId) ?? 0) < NOTICE_INTERVAL) return [];
    this.#lastNotice.set(actor.agentId, now);
    const agent = await this.deps.db.selectFrom('agents').select(['projectId', 'lastSyncAt', 'lastNoticeAt']).where('id', '=', actor.agentId).executeTakeFirst();
    if (!agent || !canAccessProject(actor, agent.projectId)) return [];
    const since = Math.max(agent.lastSyncAt ?? 0, agent.lastNoticeAt ?? 0, now - DAY);
    const out: string[] = [];

    const unread = await this.services.messages.unreadSummary(actor, [agent.projectId]);
    if (unread.count && (unread.latestAt ?? 0) > since) {
      out.push(`📬 ${unread.count} unread message(s)${unread.urgent ? `, ${unread.urgent} urgent` : ''} – call message_get_unread.`);
    }
    const important = await this.deps.db
      .selectFrom('activity')
      .select(['summary', 'actorId', 'kind'])
      .where('projectId', '=', agent.projectId)
      .where('at', '>', since)
      .where('importance', '>=', 3)
      .where((eb) => eb.or([eb('actorId', 'is', null), eb('actorId', '!=', actor.developerId)]))
      .orderBy('at', 'desc')
      .limit(3)
      .execute();
    for (const item of important) {
      const name = item.actorId ? ((await this.directory.name(item.actorId)) ?? item.actorId) : '';
      const who = name && !item.summary.startsWith(name) ? `${name} ` : '';
      out.push(`⚠ ${who}${truncate(item.summary, 200)}`);
    }
    if (out.length) await this.deps.db.updateTable('agents').set({ lastNoticeAt: now }).where('id', '=', actor.agentId).execute();
    return out;
  }

  compact = compact;
}
