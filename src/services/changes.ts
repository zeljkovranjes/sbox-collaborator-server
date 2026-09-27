import type { ChangeRow } from '../db/schema.js';
import { conflict, forbidden, invalid, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { list, parseJson, toJson } from '../lib/json.js';
import { uniquePaths } from '../lib/paths.js';
import { truncate } from '../lib/relevance.js';
import { iso } from '../lib/time.js';
import type { ActivityService } from './activity.js';
import { requireProjectAccess, type Actor, type Deps } from './context.js';
import type { Directory } from './directory.js';
import type { ProjectService } from './projects.js';

export interface Change {
  id: string;
  projectId: string;
  status: 'started' | 'completed' | 'abandoned';
  summary: string;
  developerId: string;
  developerName: string;
  agentId: string | null;
  taskId: number | null;
  branch: string | null;
  commitSha: string | null;
  files: string[];
  assets: string[];
  apisAdded: string[];
  apisRemoved: string[];
  apisRenamed: { from: string; to: string }[];
  behaviorChanges: string[];
  breakingChanges: string[];
  testsPerformed: string[];
  knownIssues: string[];
  followUps: string[];
  reason: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface ChangeDetails {
  summary: string;
  taskId?: number;
  branch?: string;
  commitSha?: string;
  files?: string[];
  assets?: string[];
  apisAdded?: string[];
  apisRemoved?: string[];
  apisRenamed?: { from: string; to: string }[];
  behaviorChanges?: string[];
  breakingChanges?: string[];
  testsPerformed?: string[];
  knownIssues?: string[];
  followUps?: string[];
}

const items = (values: string[] | undefined, max = 40) => (values ?? []).map((v) => truncate(v, 400)).filter(Boolean).slice(0, max);

export class ChangeService {
  constructor(
    private readonly deps: Deps,
    private readonly directory: Directory,
    private readonly activity: ActivityService,
    private readonly projects: ProjectService,
  ) {}

  async view(rows: ChangeRow[]): Promise<Change[]> {
    return Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        projectId: row.projectId,
        status: row.status,
        summary: row.summary,
        developerId: row.developerId,
        developerName: (await this.directory.name(row.developerId)) ?? row.developerId,
        agentId: row.agentId,
        taskId: row.taskId,
        branch: row.branch,
        commitSha: row.commitSha,
        files: list(row.files),
        assets: list(row.assets),
        apisAdded: list(row.apisAdded),
        apisRemoved: list(row.apisRemoved),
        apisRenamed: parseJson<{ from: string; to: string }[]>(row.apisRenamed, []),
        behaviorChanges: list(row.behaviorChanges),
        breakingChanges: list(row.breakingChanges),
        testsPerformed: list(row.testsPerformed),
        knownIssues: list(row.knownIssues),
        followUps: list(row.followUps),
        reason: row.reason,
        startedAt: iso(row.startedAt)!,
        completedAt: iso(row.completedAt),
      })),
    );
  }

  #values(details: ChangeDetails) {
    const values: Record<string, unknown> = {};
    if (details.taskId !== undefined) values.taskId = details.taskId;
    if (details.branch !== undefined) values.branch = details.branch;
    if (details.commitSha !== undefined) values.commitSha = details.commitSha;
    if (details.files !== undefined) values.files = toJson(uniquePaths(details.files).slice(0, 300));
    if (details.assets !== undefined) values.assets = toJson(uniquePaths(details.assets).slice(0, 300));
    if (details.apisAdded !== undefined) values.apisAdded = toJson(items(details.apisAdded));
    if (details.apisRemoved !== undefined) values.apisRemoved = toJson(items(details.apisRemoved));
    if (details.apisRenamed !== undefined) values.apisRenamed = toJson(details.apisRenamed.slice(0, 40).map((r) => ({ from: truncate(r.from, 200), to: truncate(r.to, 200) })));
    if (details.behaviorChanges !== undefined) values.behaviorChanges = toJson(items(details.behaviorChanges));
    if (details.breakingChanges !== undefined) values.breakingChanges = toJson(items(details.breakingChanges));
    if (details.testsPerformed !== undefined) values.testsPerformed = toJson(items(details.testsPerformed));
    if (details.knownIssues !== undefined) values.knownIssues = toJson(items(details.knownIssues));
    if (details.followUps !== undefined) values.followUps = toJson(items(details.followUps));
    return values;
  }

  async start(actor: Actor, input: { project: string; summary: string; taskId?: number; branch?: string; files?: string[] }): Promise<Change> {
    requireProjectAccess(actor, input.project);
    await this.projects.row(input.project);
    if (!input.summary.trim()) throw invalid('Summary is empty');
    const now = this.deps.clock.now();
    const row = await this.deps.db
      .insertInto('changes')
      .values({
        id: `ch_${newId(10)}`,
        projectId: input.project,
        agentId: actor.agentId,
        developerId: actor.developerId,
        taskId: input.taskId ?? null,
        status: 'started',
        summary: truncate(input.summary, 300),
        branch: input.branch ?? null,
        commitSha: null,
        files: toJson(uniquePaths(input.files ?? [])),
        assets: '[]',
        apisAdded: '[]',
        apisRemoved: '[]',
        apisRenamed: '[]',
        behaviorChanges: '[]',
        breakingChanges: '[]',
        testsPerformed: '[]',
        knownIssues: '[]',
        followUps: '[]',
        reason: null,
        startedAt: now,
        completedAt: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const [change] = await this.view([row]);
    const activity = await this.activity.record({ projectId: row.projectId, actor, kind: 'change', summary: `started: ${row.summary}`, refType: 'change', refId: row.id, importance: 1 });
    await this.activity.publish('change_started', row.projectId, actor, change, activity);
    return change!;
  }

  async complete(actor: Actor, input: ChangeDetails & { changeId?: string; project?: string }): Promise<Change> {
    if (!input.summary?.trim()) throw invalid('A completed change needs a summary');
    const now = this.deps.clock.now();
    let row: ChangeRow;
    if (input.changeId) {
      const existing = await this.deps.db.selectFrom('changes').selectAll().where('id', '=', input.changeId).executeTakeFirst();
      if (!existing) throw notFound(`Change ${input.changeId}`);
      requireProjectAccess(actor, existing.projectId);
      if (existing.developerId !== actor.developerId) throw forbidden('That change belongs to another developer');
      if (existing.status !== 'started') throw conflict(`Change ${input.changeId} is already ${existing.status}`);
      row = await this.deps.db
        .updateTable('changes')
        .set({ ...this.#values(input), summary: truncate(input.summary, 600), status: 'completed', completedAt: now })
        .where('id', '=', input.changeId)
        .returningAll()
        .executeTakeFirstOrThrow();
    } else {
      if (!input.project) throw invalid('Pass changeId, or project for a change that was not started');
      const started = await this.start(actor, { project: input.project, summary: input.summary, ...(input.taskId !== undefined ? { taskId: input.taskId } : {}) });
      row = await this.deps.db
        .updateTable('changes')
        .set({ ...this.#values(input), summary: truncate(input.summary, 600), status: 'completed', completedAt: now })
        .where('id', '=', started.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    }
    const [change] = await this.view([row]);
    const breaking = change!.breakingChanges.length > 0 || change!.apisRemoved.length > 0 || change!.apisRenamed.length > 0;
    const api = [
      ...change!.apisAdded.map((a) => `+${a}`),
      ...change!.apisRemoved.map((a) => `-${a}`),
      ...change!.apisRenamed.map((r) => `${r.from}→${r.to}`),
    ];
    const activity = await this.activity.record({
      projectId: row.projectId,
      actor,
      kind: breaking ? 'breaking_change' : 'change',
      summary: `completed: ${truncate(row.summary, 160)}${api.length ? ` · API ${truncate(api.join(', '), 120)}` : ''}${breaking ? ' · BREAKING' : ''}`,
      refType: 'change',
      refId: row.id,
      importance: breaking ? 3 : 2,
    });
    await this.activity.publish('change_completed', row.projectId, actor, change, activity);
    return change!;
  }

  async abandon(actor: Actor, changeId: string, reason: string): Promise<Change> {
    const existing = await this.deps.db.selectFrom('changes').selectAll().where('id', '=', changeId).executeTakeFirst();
    if (!existing) throw notFound(`Change ${changeId}`);
    requireProjectAccess(actor, existing.projectId);
    if (existing.developerId !== actor.developerId && actor.role !== 'admin') throw forbidden('That change belongs to another developer');
    if (existing.status !== 'started') throw conflict(`Change ${changeId} is already ${existing.status}`);
    const row = await this.deps.db
      .updateTable('changes')
      .set({ status: 'abandoned', reason: truncate(reason, 600), completedAt: this.deps.clock.now() })
      .where('id', '=', changeId)
      .returningAll()
      .executeTakeFirstOrThrow();
    const [change] = await this.view([row]);
    const activity = await this.activity.record({ projectId: row.projectId, actor, kind: 'change', summary: `abandoned: ${row.summary} (${truncate(reason, 120)})`, refType: 'change', refId: row.id, importance: 1 });
    await this.activity.publish('change_abandoned', row.projectId, actor, change, activity);
    return change!;
  }

  async recent(actor: Actor, projectId: string, options: { limit?: number; since?: number; includeStarted?: boolean; excludeDeveloperId?: string } = {}): Promise<Change[]> {
    requireProjectAccess(actor, projectId);
    let query = this.deps.db.selectFrom('changes').selectAll().where('projectId', '=', projectId);
    query = options.includeStarted ? query.where('status', '!=', 'abandoned') : query.where('status', '=', 'completed');
    if (options.since) query = query.where((eb) => eb.or([eb('completedAt', '>=', options.since!), eb('startedAt', '>=', options.since!)]));
    if (options.excludeDeveloperId) query = query.where('developerId', '!=', options.excludeDeveloperId);
    const rows = await query.orderBy('startedAt', 'desc').limit(Math.min(options.limit ?? 20, 100)).execute();
    return this.view(rows);
  }
}
