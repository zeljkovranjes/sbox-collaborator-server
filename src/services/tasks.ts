import { sql } from 'kysely';
import type { TaskNoteRow, TaskRow } from '../db/schema.js';
import { AppError, conflict, forbidden, invalid, notFound } from '../lib/errors.js';
import { list, parseJson, toJson } from '../lib/json.js';
import { uniquePaths } from '../lib/paths.js';
import { matchScore, tokenSet, truncate } from '../lib/relevance.js';
import { iso } from '../lib/time.js';
import type { ActivityService } from './activity.js';
import { requireProjectAccess, type Actor, type Deps } from './context.js';
import type { Directory } from './directory.js';
import type { ProjectService } from './projects.js';

export const TASK_STATUSES = ['backlog', 'available', 'claimed', 'in_progress', 'blocked', 'review', 'done'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/** Statuses in which a task belongs to someone. */
export const OWNED_STATUSES: TaskStatus[] = ['claimed', 'in_progress', 'blocked', 'review'];

export interface Task {
  id: number;
  projectId: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  ownerId: string | null;
  ownerName: string | null;
  agentId: string | null;
  relatedFiles: string[];
  relatedAssets: string[];
  dependsOn: number[];
  labels: string[];
  branch: string | null;
  githubIssue: number | null;
  githubPr: number | null;
  blockedReason: string | null;
  completionSummary: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  claimedAt: string | null;
  completedAt: string | null;
  version: number;
  /** Owned, but the owning agent has gone offline. */
  stale: boolean;
  /** The task's branch, or a suggested one: task/<id>-<slug>. */
  suggestedBranch: string;
  /** The most recent handoff note, so whoever picks it up knows where things stand. */
  lastHandoff: TaskNote | null;
}

export interface TaskNote {
  id: number;
  taskId: number;
  kind: 'handoff' | 'note';
  authorId: string;
  authorName: string;
  summary: string;
  next: string | null;
  gotchas: string | null;
  files: string[];
  toDeveloperId: string | null;
  createdAt: string;
}

export interface HandoffInput {
  summary: string;
  next?: string;
  gotchas?: string;
  files?: string[];
  to?: string;
  keepReservations?: boolean;
}

/** "Sail trim UI!" -> "task/42-sail-trim-ui" */
export function branchFor(id: number, title: string): string {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .slice(0, 6)
    .join('-')
    .slice(0, 40)
    .replace(/-+$/, '');
  return `task/${id}${words ? `-${words}` : ''}`;
}

export interface TaskCreate {
  project: string;
  title: string;
  description?: string;
  priority?: TaskPriority;
  status?: 'backlog' | 'available';
  relatedFiles?: string[];
  relatedAssets?: string[];
  dependsOn?: number[];
  labels?: string[];
  branch?: string;
  githubIssue?: number;
}

export interface TaskPatch {
  status?: TaskStatus;
  title?: string;
  description?: string;
  priority?: TaskPriority;
  relatedFiles?: string[];
  relatedAssets?: string[];
  dependsOn?: number[];
  labels?: string[];
  branch?: string | null;
  githubIssue?: number | null;
  githubPr?: number | null;
  expectedVersion?: number;
}

/** Hooks the task board uses without depending on other services directly. */
export interface TaskHooks {
  notify(actor: Actor, projectId: string, toDeveloperId: string, type: 'handoff' | 'info', body: string, taskId: number): Promise<void>;
  releaseTaskReservations(actor: Actor, projectId: string, taskId: number, reason: string): Promise<number>;
  setAgentTask(agentId: string, taskId: number | null, status?: string): Promise<void>;
}

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
const STATUS_RANK: Record<string, number> = { in_progress: 0, claimed: 1, blocked: 2, review: 3, available: 4, backlog: 5, done: 6 };

export class TaskService {
  hooks!: TaskHooks;

  constructor(
    private readonly deps: Deps,
    private readonly directory: Directory,
    private readonly activity: ActivityService,
    private readonly projects: ProjectService,
  ) {}

  async #noteViews(rows: TaskNoteRow[]): Promise<TaskNote[]> {
    return Promise.all(
      rows.map(async (n) => ({
        id: n.id,
        taskId: n.taskId,
        kind: n.kind,
        authorId: n.authorId,
        authorName: (await this.directory.name(n.authorId)) ?? n.authorId,
        summary: n.summary,
        next: n.next,
        gotchas: n.gotchas,
        files: list(n.files),
        toDeveloperId: n.toDeveloperId,
        createdAt: iso(n.createdAt)!,
      })),
    );
  }

  async notes(taskId: number): Promise<TaskNote[]> {
    const rows = await this.deps.db.selectFrom('taskNotes').selectAll().where('taskId', '=', taskId).orderBy('createdAt', 'desc').limit(50).execute();
    return this.#noteViews(rows);
  }

  async view(rows: TaskRow[]): Promise<Task[]> {
    const handoffs = new Map<number, TaskNote>();
    if (rows.length) {
      const notes = await this.deps.db
        .selectFrom('taskNotes')
        .selectAll()
        .where('taskId', 'in', rows.map((r) => r.id))
        .where('kind', '=', 'handoff')
        .orderBy('createdAt', 'desc')
        .execute();
      const latest = notes.filter((n, i) => notes.findIndex((m) => m.taskId === n.taskId) === i);
      for (const note of await this.#noteViews(latest)) handoffs.set(note.taskId, note);
    }
    const agentIds = [...new Set(rows.map((r) => r.agentId).filter((id): id is string => !!id))];
    const online = new Map<string, boolean>();
    if (agentIds.length) {
      const cutoff = this.deps.clock.now() - this.deps.config.agentOfflineAfterMs;
      for (const agent of await this.deps.db.selectFrom('agents').select(['id', 'lastHeartbeatAt', 'endedAt']).where('id', 'in', agentIds).execute()) {
        online.set(agent.id, agent.endedAt == null && agent.lastHeartbeatAt > cutoff);
      }
    }
    return Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        projectId: row.projectId,
        title: row.title,
        description: row.description,
        status: row.status as TaskStatus,
        priority: row.priority as TaskPriority,
        ownerId: row.ownerId,
        ownerName: await this.directory.name(row.ownerId),
        agentId: row.agentId,
        relatedFiles: list(row.relatedFiles),
        relatedAssets: list(row.relatedAssets),
        dependsOn: parseJson<number[]>(row.dependsOn, []),
        labels: list(row.labels),
        branch: row.branch,
        githubIssue: row.githubIssue,
        githubPr: row.githubPr,
        blockedReason: row.blockedReason,
        completionSummary: row.completionSummary,
        createdBy: row.createdBy,
        createdAt: iso(row.createdAt)!,
        updatedAt: iso(row.updatedAt)!,
        claimedAt: iso(row.claimedAt),
        completedAt: iso(row.completedAt),
        version: row.version,
        // Handed to someone whose agent has not picked it up yet: waiting, not abandoned.
        stale:
          OWNED_STATUSES.includes(row.status as TaskStatus) &&
          row.status !== 'review' &&
          !(row.agentId == null && handoffs.get(row.id)?.toDeveloperId === row.ownerId) &&
          (!row.agentId || online.get(row.agentId) !== true),
        suggestedBranch: row.branch ?? branchFor(row.id, row.title),
        lastHandoff: handoffs.get(row.id) ?? null,
      })),
    );
  }

  async #one(row: TaskRow): Promise<Task> {
    return (await this.view([row]))[0]!;
  }

  async row(taskId: number): Promise<TaskRow> {
    const row = await this.deps.db.selectFrom('tasks').selectAll().where('id', '=', taskId).executeTakeFirst();
    if (!row) throw notFound(`Task #${taskId}`);
    return row;
  }

  async #rowFor(actor: Actor, taskId: number): Promise<TaskRow> {
    const row = await this.row(taskId);
    requireProjectAccess(actor, row.projectId);
    return row;
  }

  async get(actor: Actor, taskId: number): Promise<Task> {
    return this.#one(await this.#rowFor(actor, taskId));
  }

  async create(actor: Actor, input: TaskCreate): Promise<Task> {
    requireProjectAccess(actor, input.project);
    await this.projects.row(input.project);
    const title = input.title.trim();
    if (!title) throw invalid('Task title is empty');
    const dependsOn = [...new Set(input.dependsOn ?? [])];
    if (dependsOn.length) {
      const found = await this.deps.db.selectFrom('tasks').select('id').where('id', 'in', dependsOn).where('projectId', '=', input.project).execute();
      const missing = dependsOn.filter((id) => !found.some((f) => f.id === id));
      if (missing.length) throw invalid(`Unknown dependency task(s): ${missing.map((id) => `#${id}`).join(', ')}`);
    }
    const now = this.deps.clock.now();
    const row = await this.deps.db
      .insertInto('tasks')
      .values({
        projectId: input.project,
        title: title.slice(0, 200),
        description: (input.description ?? '').slice(0, 8000),
        status: input.status ?? 'available',
        priority: input.priority ?? 'normal',
        ownerId: null,
        agentId: null,
        relatedFiles: toJson(uniquePaths(input.relatedFiles ?? [])),
        relatedAssets: toJson(uniquePaths(input.relatedAssets ?? [])),
        dependsOn: toJson(dependsOn),
        labels: toJson(input.labels ?? []),
        branch: input.branch ?? null,
        githubIssue: input.githubIssue ?? null,
        githubPr: null,
        blockedReason: null,
        completionSummary: null,
        createdBy: actor.developerId,
        createdAt: now,
        updatedAt: now,
        claimedAt: null,
        completedAt: null,
        version: 1,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const task = await this.#one(row);
    const activity = await this.activity.record({ projectId: row.projectId, actor, kind: 'task', summary: `created task #${row.id} "${row.title}"`, refType: 'task', refId: row.id, importance: 1 });
    await this.activity.publish('task_created', row.projectId, actor, task, activity);
    return task;
  }

  async list(actor: Actor, projectId: string, filter: { status?: TaskStatus[]; ownerId?: string; mine?: boolean; query?: string; limit?: number } = {}): Promise<Task[]> {
    requireProjectAccess(actor, projectId);
    let query = this.deps.db.selectFrom('tasks').selectAll().where('projectId', '=', projectId);
    if (filter.status?.length) query = query.where('status', 'in', filter.status);
    else query = query.where((eb) => eb.or([eb('status', '!=', 'done'), eb('completedAt', '>', this.deps.clock.now() - 7 * 86_400_000)]));
    if (filter.mine) query = query.where('ownerId', '=', actor.developerId);
    else if (filter.ownerId) query = query.where('ownerId', '=', filter.ownerId);
    let rows = await query.orderBy('updatedAt', 'desc').limit(500).execute();
    if (filter.query) {
      const q = tokenSet(filter.query);
      rows = rows
        .map((row) => ({ row, score: matchScore(q, tokenSet(row.title, row.description, row.relatedFiles)) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((x) => x.row);
    } else {
      rows.sort(
        (a, b) =>
          (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) ||
          (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9) ||
          b.updatedAt - a.updatedAt,
      );
    }
    return this.view(rows.slice(0, Math.min(filter.limit ?? 50, 200)));
  }

  /**
   * Claims a task. Atomic: the conditional UPDATE only succeeds while the task is unowned (or
   * already ours), so of two simultaneous claims exactly one wins.
   */
  async claim(actor: Actor, taskId: number, options: { branch?: string; force?: boolean; reason?: string } = {}): Promise<{ task: Task; warnings: string[] }> {
    const current = await this.#rowFor(actor, taskId);
    const now = this.deps.clock.now();
    const warnings: string[] = [];

    const claimed = await this.deps.db
      .updateTable('tasks')
      .set({
        status: 'claimed',
        ownerId: actor.developerId,
        agentId: actor.agentId,
        claimedAt: now,
        updatedAt: now,
        branch: options.branch ?? current.branch,
        blockedReason: null,
        version: sql<number>`version + 1`,
      })
      .where('id', '=', taskId)
      .where((eb) =>
        eb.or([
          eb('status', 'in', ['available', 'backlog']),
          eb.and([eb('ownerId', '=', actor.developerId), eb('status', 'in', OWNED_STATUSES)]),
        ]),
      )
      .returningAll()
      .executeTakeFirst();

    let row = claimed;
    let previousOwner: string | null = null;
    if (!row) {
      const latest = await this.row(taskId);
      if (latest.status === 'done') throw conflict(`Task #${taskId} is already done.`, { status: latest.status });
      const ownerName = (await this.directory.name(latest.ownerId)) ?? 'someone';
      const [latestView] = await this.view([latest]);
      if (!options.force) {
        throw new AppError(
          'conflict',
          `Task #${taskId} "${latest.title}" is already ${latest.status.replace('_', ' ')} by ${ownerName}${latestView!.stale ? ' (their agent is offline – pass force=true with a reason to take it over)' : '. Coordinate with them (message_send) or pick another task.'}`,
          { ownerId: latest.ownerId, ownerName, agentId: latest.agentId, status: latest.status, stale: latestView!.stale },
        );
      }
      if (!options.reason?.trim()) throw invalid('Taking over a task needs a reason');
      // Take-over: guarded by the version we just read, so a concurrent change still loses cleanly.
      row = await this.deps.db
        .updateTable('tasks')
        .set({ status: 'claimed', ownerId: actor.developerId, agentId: actor.agentId, claimedAt: now, updatedAt: now, branch: options.branch ?? latest.branch, version: latest.version + 1 })
        .where('id', '=', taskId)
        .where('version', '=', latest.version)
        .returningAll()
        .executeTakeFirst();
      if (!row) throw conflict(`Task #${taskId} changed while taking it over; try again.`);
      previousOwner = latest.ownerId;
    }

    const deps = parseJson<number[]>(row.dependsOn, []);
    if (deps.length) {
      const open = await this.deps.db.selectFrom('tasks').select(['id', 'title', 'status']).where('id', 'in', deps).where('status', '!=', 'done').execute();
      for (const dep of open) warnings.push(`Depends on #${dep.id} "${dep.title}" which is ${dep.status}.`);
    }

    const task = await this.#one(row);
    if (actor.agentId) await this.hooks.setAgentTask(actor.agentId, taskId, 'planning');
    const takeover = previousOwner && previousOwner !== actor.developerId;
    const activity = await this.activity.record({
      projectId: row.projectId,
      actor,
      kind: 'task',
      summary: takeover
        ? `took over task #${taskId} "${row.title}" from ${await this.directory.name(previousOwner)}: ${options.reason}`
        : `claimed "${row.title}" (#${taskId})`,
      refType: 'task',
      refId: taskId,
      importance: takeover ? 2 : 1,
    });
    await this.activity.publish('task_claimed', row.projectId, actor, task, activity);
    if (takeover && previousOwner) {
      await this.hooks.notify(actor, row.projectId, previousOwner, 'handoff', `I took over task #${taskId} "${row.title}": ${options.reason}`, taskId);
    }
    return { task, warnings };
  }

  #canManage(actor: Actor, row: TaskRow): boolean {
    return actor.role === 'admin' || row.ownerId === null || row.ownerId === actor.developerId;
  }

  async update(actor: Actor, taskId: number, patch: TaskPatch): Promise<Task> {
    const row = await this.#rowFor(actor, taskId);
    if (patch.expectedVersion !== undefined && patch.expectedVersion !== row.version) {
      throw conflict(`Task #${taskId} was changed by someone else (version ${row.version}, you had ${patch.expectedVersion}). Re-read it and retry.`, { version: row.version });
    }
    if (patch.status !== undefined && patch.status !== row.status && !this.#canManage(actor, row)) {
      throw forbidden(`Task #${taskId} belongs to ${await this.directory.name(row.ownerId)}; only they can change its status.`);
    }
    if (patch.status && ['claimed', 'in_progress'].includes(patch.status) && row.ownerId === null) {
      // Starting an unowned task goes through the atomic claim first.
      await this.claim(actor, taskId);
      return this.update(actor, taskId, { ...patch, expectedVersion: undefined });
    }
    const now = this.deps.clock.now();
    const values: Record<string, unknown> = { updatedAt: now, version: row.version + 1 };
    if (patch.title !== undefined) values.title = patch.title.trim().slice(0, 200);
    if (patch.description !== undefined) values.description = patch.description.slice(0, 8000);
    if (patch.priority !== undefined) values.priority = patch.priority;
    if (patch.relatedFiles !== undefined) values.relatedFiles = toJson(uniquePaths(patch.relatedFiles));
    if (patch.relatedAssets !== undefined) values.relatedAssets = toJson(uniquePaths(patch.relatedAssets));
    if (patch.dependsOn !== undefined) values.dependsOn = toJson([...new Set(patch.dependsOn)].filter((id) => id !== taskId));
    if (patch.labels !== undefined) values.labels = toJson(patch.labels);
    if (patch.branch !== undefined) values.branch = patch.branch;
    if (patch.githubIssue !== undefined) values.githubIssue = patch.githubIssue;
    if (patch.githubPr !== undefined) values.githubPr = patch.githubPr;
    if (patch.status !== undefined) {
      values.status = patch.status;
      if (patch.status !== 'blocked') values.blockedReason = null;
      if (patch.status === 'available' || patch.status === 'backlog') {
        values.ownerId = null;
        values.agentId = null;
      }
      if (patch.status === 'done') values.completedAt = now;
    }
    const updated = await this.deps.db
      .updateTable('tasks')
      .set(values)
      .where('id', '=', taskId)
      .where('version', '=', row.version)
      .returningAll()
      .executeTakeFirst();
    if (!updated) throw conflict(`Task #${taskId} changed at the same time; re-read it and retry.`);
    const task = await this.#one(updated);
    const statusChanged = patch.status !== undefined && patch.status !== row.status;
    const activity = statusChanged
      ? await this.activity.record({
          projectId: row.projectId,
          actor,
          kind: 'task',
          summary: `moved #${taskId} "${updated.title}" to ${patch.status!.replace('_', ' ')}`,
          refType: 'task',
          refId: taskId,
          importance: 1,
        })
      : undefined;
    if (statusChanged && patch.status === 'in_progress' && actor.agentId) await this.hooks.setAgentTask(actor.agentId, taskId, 'working');
    await this.activity.publish('task_updated', row.projectId, actor, task, activity);
    return task;
  }

  async block(actor: Actor, taskId: number, reason: string): Promise<Task> {
    const row = await this.#rowFor(actor, taskId);
    if (!this.#canManage(actor, row)) throw forbidden(`Task #${taskId} belongs to ${await this.directory.name(row.ownerId)}.`);
    if (!reason.trim()) throw invalid('A blocked task needs a reason');
    const updated = await this.deps.db
      .updateTable('tasks')
      .set({ status: 'blocked', blockedReason: truncate(reason, 1000), updatedAt: this.deps.clock.now(), version: row.version + 1 })
      .where('id', '=', taskId)
      .where('version', '=', row.version)
      .returningAll()
      .executeTakeFirst();
    if (!updated) throw conflict(`Task #${taskId} changed at the same time; retry.`);
    if (actor.agentId && updated.agentId === actor.agentId) await this.hooks.setAgentTask(actor.agentId, taskId, 'blocked');
    const task = await this.#one(updated);
    const activity = await this.activity.record({ projectId: row.projectId, actor, kind: 'blocker', summary: `blocked on #${taskId} "${row.title}": ${truncate(reason, 160)}`, refType: 'task', refId: taskId, importance: 2 });
    await this.activity.publish('task_updated', row.projectId, actor, task, activity);
    return task;
  }

  async release(actor: Actor, taskId: number, options: { reason?: string; status?: 'available' | 'backlog' } = {}): Promise<Task> {
    const row = await this.#rowFor(actor, taskId);
    if (!this.#canManage(actor, row)) throw forbidden(`Task #${taskId} belongs to ${await this.directory.name(row.ownerId)}.`);
    const updated = await this.deps.db
      .updateTable('tasks')
      .set({ status: options.status ?? 'available', ownerId: null, agentId: null, blockedReason: null, updatedAt: this.deps.clock.now(), version: row.version + 1 })
      .where('id', '=', taskId)
      .where('version', '=', row.version)
      .returningAll()
      .executeTakeFirst();
    if (!updated) throw conflict(`Task #${taskId} changed at the same time; retry.`);
    if (row.agentId) await this.hooks.setAgentTask(row.agentId, null, 'idle');
    await this.hooks.releaseTaskReservations(actor, row.projectId, taskId, 'task released');
    const task = await this.#one(updated);
    const activity = await this.activity.record({
      projectId: row.projectId,
      actor,
      kind: 'task',
      summary: `released #${taskId} "${row.title}"${options.reason ? `: ${truncate(options.reason, 160)}` : ''}`,
      refType: 'task',
      refId: taskId,
      importance: 1,
    });
    await this.activity.publish('task_updated', row.projectId, actor, task, activity);
    return task;
  }

  async complete(actor: Actor, taskId: number, input: { summary: string; commitSha?: string; status?: 'done' | 'review' }): Promise<Task> {
    const row = await this.#rowFor(actor, taskId);
    if (!this.#canManage(actor, row)) throw forbidden(`Task #${taskId} belongs to ${await this.directory.name(row.ownerId)}.`);
    if (row.status === 'done') throw conflict(`Task #${taskId} is already done.`);
    const status = input.status ?? 'done';
    const now = this.deps.clock.now();
    const summary = input.commitSha ? `${input.summary.trim()} (${input.commitSha.slice(0, 7)})` : input.summary.trim();
    const updated = await this.deps.db
      .updateTable('tasks')
      .set({
        status,
        completionSummary: truncate(summary, 4000),
        completedAt: status === 'done' ? now : null,
        ownerId: row.ownerId ?? actor.developerId,
        updatedAt: now,
        blockedReason: null,
        version: row.version + 1,
      })
      .where('id', '=', taskId)
      .where('version', '=', row.version)
      .returningAll()
      .executeTakeFirst();
    if (!updated) throw conflict(`Task #${taskId} changed at the same time; retry.`);
    if (row.agentId) await this.hooks.setAgentTask(row.agentId, null, 'idle');
    if (status === 'done') await this.hooks.releaseTaskReservations(actor, row.projectId, taskId, 'task completed');
    const task = await this.#one(updated);
    const activity = await this.activity.record({
      projectId: row.projectId,
      actor,
      kind: 'task',
      summary: `${status === 'done' ? 'completed' : 'sent to review'} "${row.title}" (#${taskId}): ${truncate(input.summary, 200)}`,
      refType: 'task',
      refId: taskId,
      importance: 2,
    });
    await this.activity.publish('task_completed', row.projectId, actor, task, activity);
    return task;
  }

  /**
   * Hands a task over: stores where things stand (summary, next steps, gotchas), then either
   * gives it to another developer (`to`) or puts it back on the board. The next agent sees the
   * note in its sync packet and on the task.
   */
  async handoff(actor: Actor, taskId: number, input: HandoffInput): Promise<Task> {
    const row = await this.#rowFor(actor, taskId);
    if (!this.#canManage(actor, row)) throw forbidden(`Task #${taskId} belongs to ${await this.directory.name(row.ownerId)}.`);
    if (row.status === 'done') throw conflict(`Task #${taskId} is already done.`);
    if (!input.summary?.trim()) throw invalid('Say where you got to (summary)');
    let to: string | null = null;
    if (input.to) {
      const developer = (await this.directory.get(input.to)) ?? (await this.directory.byGithubLogin(input.to));
      if (!developer || developer.disabled) throw notFound(`Developer "${input.to}"`);
      if (developer.projectIds && !developer.projectIds.includes(row.projectId)) throw invalid(`${developer.displayName} has no access to this project`);
      to = developer.id;
    }
    const now = this.deps.clock.now();
    await this.deps.db
      .insertInto('taskNotes')
      .values({
        taskId,
        projectId: row.projectId,
        kind: 'handoff',
        authorId: actor.developerId,
        agentId: actor.agentId,
        summary: truncate(input.summary, 2000),
        next: input.next ? truncate(input.next, 2000) : null,
        gotchas: input.gotchas ? truncate(input.gotchas, 2000) : null,
        files: toJson(uniquePaths(input.files ?? []).slice(0, 50)),
        toDeveloperId: to,
        createdAt: now,
      })
      .execute();
    const updated = await this.deps.db
      .updateTable('tasks')
      .set({
        status: to && to !== actor.developerId ? 'claimed' : 'available',
        ownerId: to && to !== actor.developerId ? to : null,
        agentId: null,
        claimedAt: to ? now : null,
        blockedReason: null,
        updatedAt: now,
        version: row.version + 1,
      })
      .where('id', '=', taskId)
      .where('version', '=', row.version)
      .returningAll()
      .executeTakeFirst();
    if (!updated) throw conflict(`Task #${taskId} changed at the same time; retry.`);
    if (row.agentId) await this.hooks.setAgentTask(row.agentId, null, 'idle');
    if (!input.keepReservations) await this.hooks.releaseTaskReservations(actor, row.projectId, taskId, 'task handed off');
    const task = await this.#one(updated);
    const toName = to ? await this.directory.name(to) : null;
    const activity = await this.activity.record({
      projectId: row.projectId,
      actor,
      kind: 'task',
      summary: `handed off #${taskId} "${row.title}"${toName ? ` to ${toName}` : ' back to the board'}: ${truncate(input.summary, 160)}`,
      refType: 'task',
      refId: taskId,
      importance: 2,
    });
    await this.activity.publish('task_handoff', row.projectId, actor, { task, note: task.lastHandoff }, activity);
    if (to && to !== actor.developerId) {
      const next = input.next ? ` Next: ${truncate(input.next, 300)}` : '';
      await this.hooks.notify(actor, row.projectId, to, 'handoff', `Handing you #${taskId} "${row.title}". Where it stands: ${truncate(input.summary, 400)}.${next}`, taskId);
    }
    return task;
  }

  /** Tasks referenced by a branch name or commit message ("#42", "task-42", "task/42-..."). */
  async findReferenced(projectId: string, texts: string[]): Promise<TaskRow[]> {
    const ids = new Set<number>();
    for (const text of texts) {
      for (const match of text.matchAll(/(?:#|\btask[-_/ ]?)(\d{1,7})\b/gi)) ids.add(Number(match[1]));
    }
    if (!ids.size) return [];
    return this.deps.db.selectFrom('tasks').selectAll().where('projectId', '=', projectId).where('id', 'in', [...ids]).execute();
  }

  async byBranch(projectId: string, branch: string): Promise<TaskRow[]> {
    return this.deps.db.selectFrom('tasks').selectAll().where('projectId', '=', projectId).where('branch', '=', branch).where('status', '!=', 'done').execute();
  }
}
