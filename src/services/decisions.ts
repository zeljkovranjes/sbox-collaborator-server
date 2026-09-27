import type { DecisionRow } from '../db/schema.js';
import { conflict, invalid, notFound } from '../lib/errors.js';
import { list, toJson } from '../lib/json.js';
import { matchScore, recency, tokenSet, truncate } from '../lib/relevance.js';
import { iso } from '../lib/time.js';
import type { ActivityService } from './activity.js';
import { requireProjectAccess, type Actor, type Deps } from './context.js';
import type { Directory } from './directory.js';
import type { ProjectService } from './projects.js';

export const DECISION_STATUSES = ['proposed', 'accepted', 'superseded', 'rejected'] as const;

export interface Decision {
  id: number;
  projectId: string;
  title: string;
  context: string;
  decision: string;
  reasoning: string;
  affectedSystems: string[];
  tags: string[];
  authorId: string;
  authorName: string;
  taskId: number | null;
  commitSha: string | null;
  status: string;
  supersededBy: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface DecisionInput {
  project: string;
  title: string;
  context: string;
  decision: string;
  reasoning: string;
  affectedSystems?: string[];
  tags?: string[];
  taskId?: number;
  commitSha?: string;
  status?: 'proposed' | 'accepted';
}

export class DecisionService {
  constructor(
    private readonly deps: Deps,
    private readonly directory: Directory,
    private readonly activity: ActivityService,
    private readonly projects: ProjectService,
  ) {}

  async view(rows: DecisionRow[]): Promise<Decision[]> {
    return Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        projectId: row.projectId,
        title: row.title,
        context: row.context,
        decision: row.decision,
        reasoning: row.reasoning,
        affectedSystems: list(row.affectedSystems),
        tags: list(row.tags),
        authorId: row.authorId,
        authorName: (await this.directory.name(row.authorId)) ?? row.authorId,
        taskId: row.taskId,
        commitSha: row.commitSha,
        status: row.status,
        supersededBy: row.supersededBy,
        createdAt: iso(row.createdAt)!,
        updatedAt: iso(row.updatedAt)!,
      })),
    );
  }

  async #insert(actor: Actor, input: DecisionInput, executor = this.deps.db): Promise<DecisionRow> {
    for (const field of ['title', 'context', 'decision', 'reasoning'] as const) {
      if (!input[field]?.trim()) throw invalid(`Decision ${field} is empty`);
    }
    const now = this.deps.clock.now();
    return executor
      .insertInto('decisions')
      .values({
        projectId: input.project,
        title: truncate(input.title, 200),
        context: truncate(input.context, 4000),
        decision: truncate(input.decision, 4000),
        reasoning: truncate(input.reasoning, 4000),
        affectedSystems: toJson((input.affectedSystems ?? []).map((s) => s.trim()).filter(Boolean)),
        tags: toJson((input.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean)),
        authorId: actor.developerId,
        agentId: actor.agentId,
        taskId: input.taskId ?? null,
        commitSha: input.commitSha ?? null,
        status: input.status ?? 'accepted',
        supersededBy: null,
        createdAt: now,
        updatedAt: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async create(actor: Actor, input: DecisionInput): Promise<Decision> {
    requireProjectAccess(actor, input.project);
    await this.projects.row(input.project);
    const row = await this.#insert(actor, input);
    const [decision] = await this.view([row]);
    const activity = await this.activity.record({ projectId: row.projectId, actor, kind: 'decision', summary: `decided: ${row.title}`, refType: 'decision', refId: row.id, importance: 2 });
    await this.activity.publish('decision_created', row.projectId, actor, decision, activity);
    return decision!;
  }

  async get(actor: Actor, id: number): Promise<Decision> {
    const row = await this.deps.db.selectFrom('decisions').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) throw notFound(`Decision ${id}`);
    requireProjectAccess(actor, row.projectId);
    return (await this.view([row]))[0]!;
  }

  /** Decisions ranked by relevance to `query` (title, systems, tags, text), then recency. */
  async list(actor: Actor, projectId: string, filter: { query?: string; system?: string; status?: string; limit?: number } = {}): Promise<Decision[]> {
    requireProjectAccess(actor, projectId);
    let query = this.deps.db.selectFrom('decisions').selectAll().where('projectId', '=', projectId);
    if (filter.status) query = query.where('status', '=', filter.status);
    else query = query.where('status', 'in', ['accepted', 'proposed']);
    let rows = await query.orderBy('createdAt', 'desc').limit(1000).execute();
    if (filter.system) {
      const system = filter.system.toLowerCase();
      rows = rows.filter((r) => list(r.affectedSystems).some((s) => s.toLowerCase().includes(system)));
    }
    if (filter.query) rows = this.rank(rows, filter.query, this.deps.clock.now()).filter((x) => x.score > 0).map((x) => x.row);
    return this.view(rows.slice(0, Math.min(filter.limit ?? 20, 100)));
  }

  rank(rows: DecisionRow[], text: string, now: number): { row: DecisionRow; score: number }[] {
    const q = tokenSet(text);
    return rows
      .map((row) => {
        const strong = tokenSet(row.title, list(row.affectedSystems).join(' '), list(row.tags).join(' '));
        const weak = tokenSet(row.decision, row.context);
        const score = matchScore(q, strong) * 2 + matchScore(q, weak) * 0.5;
        return { row, score: score > 0 ? score + recency(row.createdAt, now, 30 * 86_400_000) : 0 };
      })
      .sort((a, b) => b.score - a.score);
  }

  async supersede(actor: Actor, id: number, replacement: Omit<DecisionInput, 'project'>, reason: string): Promise<{ old: Decision; new: Decision }> {
    const old = await this.deps.db.selectFrom('decisions').selectAll().where('id', '=', id).executeTakeFirst();
    if (!old) throw notFound(`Decision ${id}`);
    requireProjectAccess(actor, old.projectId);
    if (old.status === 'superseded') throw conflict(`Decision ${id} was already superseded by ${old.supersededBy}`);
    if (!reason.trim()) throw invalid('Say why the decision changes');
    const result = await this.deps.db.transaction().execute(async (trx) => {
      const created = await this.#insert(actor, { ...replacement, project: old.projectId, context: `${replacement.context}\n\nSupersedes decision ${id} ("${old.title}"): ${reason}` }, trx as any);
      const updated = await trx
        .updateTable('decisions')
        .set({ status: 'superseded', supersededBy: created.id, updatedAt: this.deps.clock.now() })
        .where('id', '=', id)
        .where('status', '!=', 'superseded')
        .returningAll()
        .executeTakeFirst();
      if (!updated) throw conflict(`Decision ${id} was superseded at the same time`);
      return { old: updated, created };
    });
    const [oldView, newView] = await this.view([result.old, result.created]);
    const activity = await this.activity.record({
      projectId: old.projectId,
      actor,
      kind: 'decision',
      summary: `replaced decision "${old.title}" with "${result.created.title}": ${truncate(reason, 140)}`,
      refType: 'decision',
      refId: result.created.id,
      importance: 2,
    });
    await this.activity.publish('decision_superseded', old.projectId, actor, { old: oldView, new: newView }, activity);
    return { old: oldView!, new: newView! };
  }
}
