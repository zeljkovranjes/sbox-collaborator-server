import type { Db, Tx } from '../db/index.js';
import type { ReservationRow } from '../db/schema.js';
import { forbidden, invalid } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { isDirectoryPath, overlap, pathKey, uniquePaths, type Overlap } from '../lib/paths.js';
import { truncate } from '../lib/relevance.js';
import { iso } from '../lib/time.js';
import type { ActivityService } from './activity.js';
import { requireProjectAccess, type Actor, type Deps } from './context.js';
import type { Directory } from './directory.js';
import type { ProjectService } from './projects.js';

export interface Reservation {
  id: string;
  projectId: string;
  path: string;
  isDirectory: boolean;
  developerId: string;
  developerName: string;
  agentId: string | null;
  agentLabel: string | null;
  taskId: number | null;
  taskTitle: string | null;
  reason: string;
  branch: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface Conflict {
  path: string;
  relation: Exclude<Overlap, null>;
  reservation: Reservation;
  message: string;
}

export interface ReserveInput {
  project: string;
  paths: string[];
  reason: string;
  taskId?: number;
  branch?: string;
  ttlMinutes?: number;
  force?: boolean;
}

export interface ReservationHooks {
  warn(actor: Actor, projectId: string, toDeveloperId: string, body: string, paths: string[], taskId: number | null): Promise<void>;
}

type ActiveRow = ReservationRow & { agentLabel: string | null; taskTitle: string | null };

export class ReservationService {
  hooks!: ReservationHooks;

  constructor(
    private readonly deps: Deps,
    private readonly directory: Directory,
    private readonly activity: ActivityService,
    private readonly projects: ProjectService,
  ) {}

  /** Last heartbeat an agent may have and still hold reservations. */
  get #agentHorizon() {
    return this.deps.clock.now() - this.deps.config.agentOfflineAfterMs - this.deps.config.reservationGraceMs;
  }

  /** Active = not released, not expired, and its agent (if any) has not been gone past the grace period. */
  async #active(executor: Db | Tx, projectId: string): Promise<ActiveRow[]> {
    const now = this.deps.clock.now();
    return executor
      .selectFrom('reservations as r')
      .leftJoin('agents as a', 'a.id', 'r.agentId')
      .leftJoin('tasks as t', 't.id', 'r.taskId')
      .selectAll('r')
      .select(['a.label as agentLabel', 't.title as taskTitle'])
      .where('r.projectId', '=', projectId)
      .where('r.releasedAt', 'is', null)
      .where('r.expiresAt', '>', now)
      .where((eb) => eb.or([eb('r.agentId', 'is', null), eb('a.lastHeartbeatAt', '>', this.#agentHorizon)]))
      .orderBy('r.createdAt', 'desc')
      .execute();
  }

  async #view(rows: ActiveRow[]): Promise<Reservation[]> {
    return Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        projectId: row.projectId,
        path: row.path,
        isDirectory: row.isDirectory === 1,
        developerId: row.developerId,
        developerName: (await this.directory.name(row.developerId)) ?? row.developerId,
        agentId: row.agentId,
        agentLabel: row.agentLabel,
        taskId: row.taskId,
        taskTitle: row.taskTitle,
        reason: row.reason,
        branch: row.branch,
        createdAt: iso(row.createdAt)!,
        expiresAt: iso(row.expiresAt)!,
      })),
    );
  }

  #conflictMessage(view: Reservation, path: string, relation: Exclude<Overlap, null>): string {
    const where = relation === 'exact' ? path : relation === 'inside' ? `${path} (inside reserved ${view.path})` : `${path} (contains reserved ${view.path})`;
    const task = view.taskId ? ` for task #${view.taskId}${view.taskTitle ? ` "${view.taskTitle}"` : ''}` : '';
    const agent = view.agentLabel ? ` (${view.agentLabel})` : '';
    return `${where} is reserved by ${view.developerName}${agent}${task}: ${view.reason}`;
  }

  async #conflicts(active: ActiveRow[], paths: string[], actor: Actor): Promise<Conflict[]> {
    const others = active.filter((r) => r.developerId !== actor.developerId);
    const views = await this.#view(others);
    const out: Conflict[] = [];
    for (const path of paths) {
      const key = pathKey(path);
      others.forEach((row, index) => {
        const relation = overlap(key, row.pathKey);
        if (!relation) return;
        const view = views[index]!;
        out.push({ path, relation, reservation: view, message: this.#conflictMessage(view, path, relation) });
      });
    }
    return out;
  }

  async reserve(actor: Actor, input: ReserveInput): Promise<{ reserved: Reservation[]; conflicts: Conflict[]; message: string }> {
    requireProjectAccess(actor, input.project);
    await this.projects.row(input.project);
    const paths = uniquePaths(input.paths);
    if (!paths.length) throw invalid('No paths to reserve');
    if (paths.length > 100) throw invalid('Reserve at most 100 paths at once (reserve a directory instead)');
    if (!input.reason?.trim()) throw invalid('A reservation needs a reason');
    const ttl = Math.min(
      input.ttlMinutes ? input.ttlMinutes * 60_000 : this.deps.config.reservationDefaultTtlMs,
      this.deps.config.reservationMaxTtlMs,
    );
    if (ttl < 60_000) throw invalid('ttlMinutes must be at least 1');

    const result = await this.deps.locks.run(`reservations:${input.project}`, () =>
      this.deps.db.transaction().execute(async (trx) => {
        await this.deps.database.lock(trx, `reservations:${input.project}`);
        const now = this.deps.clock.now();
        const active = await this.#active(trx, input.project);
        const conflicts = await this.#conflicts(active, paths, actor);
        const blocked = new Set(input.force ? [] : conflicts.map((c) => c.path));
        const reservedIds: string[] = [];
        for (const path of paths) {
          if (blocked.has(path)) continue;
          const key = pathKey(path);
          const own = active.find((r) => r.pathKey === key && r.developerId === actor.developerId && r.agentId === actor.agentId);
          if (own) {
            await trx
              .updateTable('reservations')
              .set({ expiresAt: now + ttl, reason: truncate(input.reason, 500), taskId: input.taskId ?? own.taskId, branch: input.branch ?? own.branch })
              .where('id', '=', own.id)
              .execute();
            reservedIds.push(own.id);
            continue;
          }
          const id = `rs_${newId(10)}`;
          await trx
            .insertInto('reservations')
            .values({
              id,
              projectId: input.project,
              path,
              pathKey: key,
              isDirectory: isDirectoryPath(path) ? 1 : 0,
              developerId: actor.developerId,
              agentId: actor.agentId,
              taskId: input.taskId ?? null,
              reason: truncate(input.reason, 500),
              branch: input.branch ?? null,
              createdAt: now,
              expiresAt: now + ttl,
              releasedAt: null,
              releaseReason: null,
            })
            .execute();
          reservedIds.push(id);
        }
        return { conflicts, reservedIds };
      }),
    );

    const all = await this.#active(this.deps.db, input.project);
    const reserved = await this.#view(all.filter((r) => result.reservedIds.includes(r.id)));
    const forced = input.force ? result.conflicts : [];
    const skipped = input.force ? [] : result.conflicts;

    if (reserved.length) {
      const names = reserved.map((r) => r.path);
      const activity = await this.activity.record({
        projectId: input.project,
        actor,
        kind: 'reservation',
        summary: `reserved ${names.slice(0, 4).join(', ')}${names.length > 4 ? ` +${names.length - 4} more` : ''}${input.taskId ? ` for #${input.taskId}` : ''}`,
        refType: 'reservation',
        refId: reserved[0]!.id,
        importance: forced.length ? 2 : 1,
      });
      await this.activity.publish('file_reserved', input.project, actor, { reservations: reserved, forced: forced.length > 0 }, activity);
    }
    for (const [developerId, items] of groupBy(forced, (c) => c.reservation.developerId)) {
      await this.hooks.warn(
        actor,
        input.project,
        developerId,
        `${actor.displayName} force-reserved ${items.map((c) => c.path).join(', ')} which overlaps your reservation: ${input.reason}`,
        items.map((c) => c.path),
        input.taskId ?? null,
      );
    }

    let message: string;
    if (!skipped.length) message = forced.length ? `Reserved ${reserved.length} path(s). Overrode ${forced.length} conflicting reservation(s); the owners were warned.` : `Reserved ${reserved.length} path(s) until ${reserved[0]?.expiresAt ?? '-'}.`;
    else message = `Not reserved – ${skipped.length} conflict(s):\n${skipped.map((c) => `- ${c.message}`).join('\n')}\nCoordinate with the owner (message_send) or pick other files. Reserved ${reserved.length} other path(s).`;
    return { reserved, conflicts: result.conflicts, message };
  }

  async release(actor: Actor, input: { project: string; paths?: string[]; reservationIds?: string[]; all?: boolean }): Promise<{ released: number }> {
    requireProjectAccess(actor, input.project);
    const active = await this.#active(this.deps.db, input.project);
    let targets: ActiveRow[];
    if (input.reservationIds?.length) {
      targets = active.filter((r) => input.reservationIds!.includes(r.id));
      const foreign = targets.filter((r) => r.developerId !== actor.developerId);
      if (foreign.length && actor.role !== 'admin') throw forbidden(`Reservation ${foreign[0]!.path} belongs to ${await this.directory.name(foreign[0]!.developerId)}.`);
    } else if (input.paths?.length) {
      const keys = new Set(uniquePaths(input.paths).map((p) => p.toLowerCase()));
      targets = active.filter((r) => r.developerId === actor.developerId && keys.has(r.pathKey));
    } else if (input.all) {
      targets = active.filter((r) => r.developerId === actor.developerId && (!actor.agentId || r.agentId === actor.agentId));
    } else {
      throw invalid('Pass paths, reservationIds or all=true');
    }
    return { released: await this.#releaseRows(actor, input.project, targets, 'released') };
  }

  async #releaseRows(actor: Actor | null, projectId: string, rows: ActiveRow[], reason: string): Promise<number> {
    if (!rows.length) return 0;
    const now = this.deps.clock.now();
    const result = await this.deps.db
      .updateTable('reservations')
      .set({ releasedAt: now, releaseReason: reason })
      .where('id', 'in', rows.map((r) => r.id))
      .where('releasedAt', 'is', null)
      .executeTakeFirst();
    const count = Number(result.numUpdatedRows ?? 0);
    if (count) {
      const views = await this.#view(rows);
      const who = actor ?? { developerId: rows[0]!.developerId, agentId: rows[0]!.agentId };
      const names = rows.map((r) => r.path);
      const expired = reason !== 'released' && !reason.startsWith('task');
      const activity = await this.activity.record({
        projectId,
        actor: who,
        kind: 'reservation',
        summary: `${expired ? `reservation ${reason === 'expired' ? 'expired' : 'dropped (agent offline)'}:` : 'released'} ${names.slice(0, 4).join(', ')}${names.length > 4 ? ` +${names.length - 4} more` : ''}`,
        refType: 'reservation',
        refId: rows[0]!.id,
        importance: 1,
      });
      await this.activity.publish(expired ? 'reservation_expired' : 'file_released', projectId, who, { reservations: views, reason }, activity);
    }
    return count;
  }

  async releaseForTask(actor: Actor, projectId: string, taskId: number, reason: string): Promise<number> {
    const active = await this.#active(this.deps.db, projectId);
    return this.#releaseRows(actor, projectId, active.filter((r) => r.taskId === taskId), reason);
  }

  async list(actor: Actor, projectId: string, filter: { path?: string; developerId?: string; mine?: boolean } = {}): Promise<Reservation[]> {
    requireProjectAccess(actor, projectId);
    let rows = await this.#active(this.deps.db, projectId);
    if (filter.mine) rows = rows.filter((r) => r.developerId === actor.developerId);
    else if (filter.developerId) rows = rows.filter((r) => r.developerId === filter.developerId);
    if (filter.path) {
      const key = pathKey(filter.path);
      rows = rows.filter((r) => overlap(key, r.pathKey) !== null);
    }
    return this.#view(rows);
  }

  async checkConflict(actor: Actor, projectId: string, paths: string[]): Promise<{ clear: boolean; conflicts: Conflict[]; message: string }> {
    requireProjectAccess(actor, projectId);
    const clean = uniquePaths(paths);
    const conflicts = await this.#conflicts(await this.#active(this.deps.db, projectId), clean, actor);
    return {
      clear: conflicts.length === 0,
      conflicts,
      message: conflicts.length
        ? `WARNING – reserved by another developer:\n${conflicts.map((c) => `- ${c.message}`).join('\n')}\nDo not edit these without coordinating (message_send).`
        : `Clear: none of the ${clean.length} path(s) are reserved by anyone else.`,
    };
  }

  /** Reservations of other developers that overlap files someone just pushed (webhooks). */
  async overlapping(projectId: string, files: string[], exceptDeveloperId: string | null): Promise<Conflict[]> {
    const active = (await this.#active(this.deps.db, projectId)).filter((r) => r.developerId !== exceptDeveloperId);
    const views = await this.#view(active);
    const out: Conflict[] = [];
    for (const file of files) {
      let key: string;
      try {
        key = pathKey(file);
      } catch {
        continue;
      }
      active.forEach((row, index) => {
        const relation = overlap(key, row.pathKey);
        if (relation) out.push({ path: file, relation, reservation: views[index]!, message: this.#conflictMessage(views[index]!, file, relation) });
      });
    }
    return out;
  }

  /** Releases expired reservations and those whose agent disappeared (sweeper). */
  async sweep(): Promise<number> {
    const now = this.deps.clock.now();
    const candidates = await this.deps.db
      .selectFrom('reservations as r')
      .leftJoin('agents as a', 'a.id', 'r.agentId')
      .leftJoin('tasks as t', 't.id', 'r.taskId')
      .selectAll('r')
      .select(['a.label as agentLabel', 't.title as taskTitle', 'a.lastHeartbeatAt as agentHeartbeat'])
      .where('r.releasedAt', 'is', null)
      .where((eb) => eb.or([eb('r.expiresAt', '<=', now), eb.and([eb('r.agentId', 'is not', null), eb('a.lastHeartbeatAt', '<=', this.#agentHorizon)])]))
      .execute();
    let released = 0;
    const groups = groupBy(candidates, (r) => `${r.projectId}\u0000${r.expiresAt <= now ? 'expired' : 'agent_offline'}`);
    for (const [key, rows] of groups) {
      const [projectId, reason] = key.split('\u0000') as [string, string];
      released += await this.#releaseRows(null, projectId, rows, reason);
    }
    return released;
  }
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = map.get(k);
    if (bucket) bucket.push(item);
    else map.set(k, [item]);
  }
  return map;
}
