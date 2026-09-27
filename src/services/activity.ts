import type { ActivityRow } from '../db/schema.js';
import type { Db, Tx } from '../db/index.js';
import type { EventType } from '../events/bus.js';
import { toJson } from '../lib/json.js';
import { iso } from '../lib/time.js';
import type { Actor, Deps } from './context.js';
import type { Directory } from './directory.js';

export interface ActivityInput {
  projectId: string;
  actor?: Pick<Actor, 'developerId' | 'agentId'> | null;
  kind: string;
  summary: string;
  refType?: string;
  refId?: string | number;
  /** 0 noise … 3 critical (breaking change, broken build). */
  importance?: 0 | 1 | 2 | 3;
  data?: unknown;
}

export interface Activity {
  id: number;
  projectId: string;
  at: string;
  actorId: string | null;
  actorName: string | null;
  agentId: string | null;
  agentLabel: string | null;
  kind: string;
  summary: string;
  refType: string | null;
  refId: string | null;
  importance: number;
}

/** The chronological feed, and the single place that emits realtime events for it. */
export class ActivityService {
  constructor(
    private readonly deps: Deps,
    private readonly directory: Directory,
  ) {}

  /**
   * Records an activity row (inside `trx` when given) and emits `eventType` + `activity`
   * after the caller's transaction commits (call `publish` with the returned closure).
   */
  async record(input: ActivityInput, executor: Db | Tx = this.deps.db): Promise<ActivityRow> {
    const row = await executor
      .insertInto('activity')
      .values({
        projectId: input.projectId,
        at: this.deps.clock.now(),
        actorId: input.actor?.developerId ?? null,
        agentId: input.actor?.agentId ?? null,
        kind: input.kind,
        summary: input.summary,
        refType: input.refType ?? null,
        refId: input.refId == null ? null : String(input.refId),
        importance: input.importance ?? 1,
        data: input.data === undefined ? null : toJson(input.data),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return row;
  }

  /** Sends realtime events. Call after the transaction that wrote the data has committed. */
  async publish(type: EventType, projectId: string, actor: Pick<Actor, 'developerId' | 'agentId'> | null, data: unknown, activity?: ActivityRow, audience?: string[]) {
    const at = new Date(this.deps.clock.now()).toISOString();
    const eventActor = { developerId: actor?.developerId ?? null, agentId: actor?.agentId ?? null };
    this.deps.bus.emit({ type, projectId, at, actor: eventActor, data, ...(audience ? { audience } : {}) });
    if (activity) {
      const [view] = await this.view([activity]);
      this.deps.bus.emit({ type: 'activity', projectId, at, actor: eventActor, data: view, ...(audience ? { audience } : {}) });
    }
  }

  async view(rows: ActivityRow[]): Promise<Activity[]> {
    const agentIds = [...new Set(rows.map((r) => r.agentId).filter((id): id is string => !!id))];
    const labels = new Map<string, string>();
    if (agentIds.length) {
      const agents = await this.deps.db.selectFrom('agents').select(['id', 'label']).where('id', 'in', agentIds).execute();
      for (const agent of agents) labels.set(agent.id, agent.label);
    }
    return Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        projectId: row.projectId,
        at: iso(row.at)!,
        actorId: row.actorId,
        actorName: await this.directory.name(row.actorId),
        agentId: row.agentId,
        agentLabel: row.agentId ? (labels.get(row.agentId) ?? null) : null,
        kind: row.kind,
        summary: row.summary,
        refType: row.refType,
        refId: row.refId,
        importance: row.importance,
      })),
    );
  }

  async recent(projectId: string, options: { limit?: number; since?: number; minImportance?: number; agentId?: string; developerId?: string } = {}) {
    let query = this.deps.db.selectFrom('activity').selectAll().where('projectId', '=', projectId);
    if (options.since) query = query.where('at', '>=', options.since);
    if (options.minImportance) query = query.where('importance', '>=', options.minImportance);
    if (options.agentId) query = query.where('agentId', '=', options.agentId);
    if (options.developerId) query = query.where('actorId', '=', options.developerId);
    const rows = await query
      .orderBy('at', 'desc')
      .orderBy('id', 'desc')
      .limit(Math.min(options.limit ?? 50, 200))
      .execute();
    return this.view(rows);
  }

  /** Activity across projects for one agent/developer (agent_get_activity). */
  async byActor(options: { agentId?: string; developerId?: string; projectIds: string[] | null; limit?: number }) {
    let query = this.deps.db.selectFrom('activity').selectAll();
    if (options.agentId) query = query.where('agentId', '=', options.agentId);
    if (options.developerId) query = query.where('actorId', '=', options.developerId);
    if (options.projectIds) query = query.where('projectId', 'in', options.projectIds.length ? options.projectIds : ['']);
    const rows = await query.orderBy('at', 'desc').limit(Math.min(options.limit ?? 50, 200)).execute();
    return this.view(rows);
  }
}
