import type { AgentRow } from '../db/schema.js';
import { forbidden, invalid, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { list, toJson } from '../lib/json.js';
import { uniquePaths } from '../lib/paths.js';
import { iso } from '../lib/time.js';
import type { ActivityService } from './activity.js';
import { requireProjectAccess, type Actor, type Deps } from './context.js';
import type { Directory } from './directory.js';
import type { ProjectService } from './projects.js';

export const AGENT_STATUSES = ['idle', 'planning', 'working', 'testing', 'blocked', 'reviewing', 'offline'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const CLIENT_TYPES = ['claude-code', 'codex', 'cursor', 'opencode', 'sbox-editor', 'dashboard', 'other'] as const;

export interface Agent {
  id: string;
  developerId: string;
  developerName: string;
  projectId: string;
  clientType: string;
  machine: string | null;
  model: string | null;
  label: string;
  status: AgentStatus;
  statusNote: string | null;
  currentTaskId: number | null;
  currentTaskTitle: string | null;
  branch: string | null;
  files: string[];
  startedAt: string;
  lastHeartbeatAt: string;
  online: boolean;
}

export interface RegisterInput {
  project: string;
  clientType: string;
  machine?: string;
  model?: string;
  label?: string;
  branch?: string;
  resumeAgentId?: string;
}

export interface StatusPatch {
  status?: AgentStatus;
  note?: string | null;
  currentTaskId?: number | null;
  branch?: string | null;
  files?: string[];
}

const HEARTBEAT_WRITE_INTERVAL = 15_000;

export class AgentService {
  #lastTouch = new Map<string, number>();

  constructor(
    private readonly deps: Deps,
    private readonly directory: Directory,
    private readonly activity: ActivityService,
    private readonly projects: ProjectService,
  ) {}

  get #offlineAfter() {
    return this.deps.config.agentOfflineAfterMs;
  }

  isOnline(row: Pick<AgentRow, 'lastHeartbeatAt' | 'endedAt'>): boolean {
    return row.endedAt == null && row.lastHeartbeatAt > this.deps.clock.now() - this.#offlineAfter;
  }

  async view(rows: AgentRow[]): Promise<Agent[]> {
    const taskIds = [...new Set(rows.map((r) => r.currentTaskId).filter((id): id is number => id != null))];
    const titles = new Map<number, string>();
    if (taskIds.length) {
      for (const task of await this.deps.db.selectFrom('tasks').select(['id', 'title']).where('id', 'in', taskIds).execute()) titles.set(task.id, task.title);
    }
    return Promise.all(
      rows.map(async (row) => {
        const online = this.isOnline(row);
        return {
          id: row.id,
          developerId: row.developerId,
          developerName: (await this.directory.name(row.developerId)) ?? row.developerId,
          projectId: row.projectId,
          clientType: row.clientType,
          machine: row.machine,
          model: row.model,
          label: row.label,
          status: (online ? row.status : 'offline') as AgentStatus,
          statusNote: row.statusNote,
          currentTaskId: row.currentTaskId,
          currentTaskTitle: row.currentTaskId != null ? (titles.get(row.currentTaskId) ?? null) : null,
          branch: row.branch,
          files: list(row.files),
          startedAt: iso(row.startedAt)!,
          lastHeartbeatAt: iso(row.lastHeartbeatAt)!,
          online,
        };
      }),
    );
  }

  async row(agentId: string): Promise<AgentRow> {
    const row = await this.deps.db.selectFrom('agents').selectAll().where('id', '=', agentId).executeTakeFirst();
    if (!row) throw notFound(`Agent "${agentId}"`);
    return row;
  }

  async get(agentId: string): Promise<Agent> {
    const [agent] = await this.view([await this.row(agentId)]);
    return agent!;
  }

  /**
   * The agent a call acts as: the explicit/session agent, or – when a client lost its session
   * (server restart, reconnect) – the most recent live agent registered with the same key.
   */
  async resolve(actor: Actor, projectId?: string): Promise<AgentRow | null> {
    if (actor.agentId) {
      const row = await this.deps.db.selectFrom('agents').selectAll().where('id', '=', actor.agentId).executeTakeFirst();
      if (row && row.developerId === actor.developerId) return row;
      return null;
    }
    if (!actor.keyId) return null;
    const horizon = this.deps.clock.now() - this.#offlineAfter - this.deps.config.reservationGraceMs;
    let query = this.deps.db
      .selectFrom('agents')
      .selectAll()
      .where('keyId', '=', actor.keyId)
      .where('endedAt', 'is', null)
      .where('lastHeartbeatAt', '>', horizon);
    if (projectId) query = query.where('projectId', '=', projectId);
    return (await query.orderBy('lastHeartbeatAt', 'desc').executeTakeFirst()) ?? null;
  }

  async register(actor: Actor, input: RegisterInput): Promise<Agent> {
    requireProjectAccess(actor, input.project);
    await this.projects.row(input.project);
    const now = this.deps.clock.now();
    const clientType = input.clientType.trim().toLowerCase() || 'other';
    const machine = input.machine?.trim() || null;
    const horizon = now - this.#offlineAfter - this.deps.config.reservationGraceMs;

    // Reconnects reuse the same agent so its task and reservations carry over.
    let existing: AgentRow | undefined;
    if (input.resumeAgentId) {
      existing = await this.deps.db.selectFrom('agents').selectAll().where('id', '=', input.resumeAgentId).executeTakeFirst();
      if (existing && existing.developerId !== actor.developerId) throw forbidden('That agent belongs to another developer');
      if (existing && existing.projectId !== input.project) existing = undefined;
    }
    if (!existing) {
      let query = this.deps.db
        .selectFrom('agents')
        .selectAll()
        .where('developerId', '=', actor.developerId)
        .where('projectId', '=', input.project)
        .where('clientType', '=', clientType)
        .where('endedAt', 'is', null)
        .where('lastHeartbeatAt', '>', horizon);
      query = machine ? query.where('machine', '=', machine) : query.where('machine', 'is', null);
      existing = await query.orderBy('lastHeartbeatAt', 'desc').executeTakeFirst();
    }

    const label = (input.label?.trim() || `${actor.developerId}/${clientType}${machine ? `@${machine}` : ''}`).slice(0, 80);
    let row: AgentRow;
    let revived = false;
    if (existing) {
      revived = !this.isOnline(existing);
      row = await this.deps.db
        .updateTable('agents')
        .set({
          lastHeartbeatAt: now,
          endedAt: null,
          keyId: actor.keyId,
          model: input.model ?? existing.model,
          label: input.label ? label : existing.label,
          branch: input.branch ?? existing.branch,
          status: existing.status === 'offline' ? 'idle' : existing.status,
        })
        .where('id', '=', existing.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    } else {
      revived = true;
      row = await this.deps.db
        .insertInto('agents')
        .values({
          id: `ag_${newId(10)}`,
          developerId: actor.developerId,
          keyId: actor.keyId,
          projectId: input.project,
          clientType,
          machine,
          model: input.model?.trim() || null,
          label,
          status: 'idle',
          statusNote: null,
          currentTaskId: null,
          branch: input.branch?.trim() || null,
          files: '[]',
          startedAt: now,
          lastHeartbeatAt: now,
          endedAt: null,
          lastSyncAt: null,
          lastNoticeAt: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    }
    this.#lastTouch.set(row.id, now);
    const agent = (await this.view([row]))[0]!;
    if (revived) {
      const who = { developerId: actor.developerId, agentId: row.id };
      const activity = await this.activity.record({
        projectId: row.projectId,
        actor: who,
        kind: 'agent',
        summary: `${row.label} came online${row.model ? ` (${row.model})` : ''}`,
        refType: 'agent',
        refId: row.id,
        importance: 0,
      });
      await this.activity.publish('agent_registered', row.projectId, who, agent, activity);
    }
    return agent;
  }

  /** Any authenticated call from an agent counts as a heartbeat (throttled DB write). */
  async touch(agentId: string): Promise<void> {
    const now = this.deps.clock.now();
    if (now - (this.#lastTouch.get(agentId) ?? 0) < HEARTBEAT_WRITE_INTERVAL) return;
    this.#lastTouch.set(agentId, now);
    const before = await this.deps.db.selectFrom('agents').select(['status', 'lastHeartbeatAt', 'endedAt', 'projectId', 'developerId', 'label']).where('id', '=', agentId).executeTakeFirst();
    if (!before) return;
    const wasOffline = before.endedAt != null || before.lastHeartbeatAt <= now - this.#offlineAfter;
    await this.deps.db
      .updateTable('agents')
      .set({ lastHeartbeatAt: now, endedAt: null, status: before.status === 'offline' ? 'idle' : before.status })
      .where('id', '=', agentId)
      .execute();
    if (wasOffline) {
      // The agent was considered offline: announce it is back.
      const who = { developerId: before.developerId, agentId };
      const agent = await this.get(agentId);
      await this.activity.publish('agent_status_changed', before.projectId, who, agent);
    }
  }

  async heartbeat(actor: Actor, agentId: string, patch: StatusPatch): Promise<Agent> {
    const row = await this.row(agentId);
    if (row.developerId !== actor.developerId) throw forbidden('That agent belongs to another developer');
    this.#lastTouch.set(agentId, 0);
    await this.touch(agentId);
    if (Object.values(patch).some((v) => v !== undefined)) return this.setStatus(actor, agentId, patch);
    return this.get(agentId);
  }

  async setStatus(actor: Actor, agentId: string, patch: StatusPatch): Promise<Agent> {
    const row = await this.row(agentId);
    if (row.developerId !== actor.developerId) throw forbidden('That agent belongs to another developer');
    if (patch.status && !AGENT_STATUSES.includes(patch.status)) throw invalid(`Unknown status "${patch.status}"`);
    const now = this.deps.clock.now();
    const values: Partial<AgentRow> = { lastHeartbeatAt: now };
    if (patch.status !== undefined) values.status = patch.status;
    if (patch.note !== undefined) values.statusNote = patch.note?.slice(0, 280) ?? null;
    if (patch.currentTaskId !== undefined) values.currentTaskId = patch.currentTaskId;
    if (patch.branch !== undefined) values.branch = patch.branch;
    if (patch.files !== undefined) values.files = toJson(uniquePaths(patch.files).slice(0, 50));
    const updated = await this.deps.db.updateTable('agents').set(values).where('id', '=', agentId).returningAll().executeTakeFirstOrThrow();
    this.#lastTouch.set(agentId, now);

    const agent = (await this.view([updated]))[0]!;
    const statusChanged = patch.status !== undefined && patch.status !== row.status;
    const taskChanged = patch.currentTaskId !== undefined && patch.currentTaskId !== row.currentTaskId;
    const who = { developerId: actor.developerId, agentId };
    if (statusChanged || taskChanged) {
      const doing = agent.currentTaskTitle ? ` on "${agent.currentTaskTitle}"` : '';
      const note = agent.statusNote ? ` – ${agent.statusNote}` : '';
      const activity = await this.activity.record({
        projectId: row.projectId,
        actor: who,
        kind: 'agent',
        summary: `${agent.label} is ${agent.status}${doing}${note}`,
        refType: 'agent',
        refId: agentId,
        importance: agent.status === 'blocked' ? 2 : 0,
      });
      await this.activity.publish('agent_status_changed', row.projectId, who, agent, activity);
    } else {
      await this.activity.publish('agent_status_changed', row.projectId, who, agent);
    }
    return agent;
  }

  async listActive(actor: Actor, projectId: string): Promise<Agent[]> {
    requireProjectAccess(actor, projectId);
    const rows = await this.deps.db
      .selectFrom('agents')
      .selectAll()
      .where('projectId', '=', projectId)
      .where('endedAt', 'is', null)
      .where('lastHeartbeatAt', '>', this.deps.clock.now() - this.#offlineAfter)
      .orderBy('lastHeartbeatAt', 'desc')
      .execute();
    return this.view(rows);
  }

  async markSynced(agentId: string): Promise<void> {
    await this.deps.db.updateTable('agents').set({ lastSyncAt: this.deps.clock.now() }).where('id', '=', agentId).execute();
  }

  /** MCP session closed: the agent stays until it times out, so a quick reconnect keeps its work. */
  async disconnected(agentId: string): Promise<void> {
    this.#lastTouch.delete(agentId);
  }

  /** Marks agents that stopped calling as offline (sweeper). Returns how many changed. */
  async sweepOffline(): Promise<number> {
    const cutoff = this.deps.clock.now() - this.#offlineAfter;
    const stale = await this.deps.db
      .selectFrom('agents')
      .selectAll()
      .where('endedAt', 'is', null)
      .where('status', '!=', 'offline')
      .where('lastHeartbeatAt', '<=', cutoff)
      .execute();
    for (const row of stale) {
      const updated = await this.deps.db
        .updateTable('agents')
        .set({ status: 'offline' })
        .where('id', '=', row.id)
        .where('lastHeartbeatAt', '<=', cutoff)
        .returningAll()
        .executeTakeFirst();
      if (!updated) continue;
      const who = { developerId: row.developerId, agentId: row.id };
      const activity = await this.activity.record({
        projectId: row.projectId,
        actor: who,
        kind: 'agent',
        summary: `${row.label} went offline`,
        refType: 'agent',
        refId: row.id,
        importance: 0,
      });
      await this.activity.publish('agent_offline', row.projectId, who, (await this.view([updated]))[0], activity);
    }
    // Agents gone for longer than the reservation grace are ended for good.
    const endCutoff = cutoff - this.deps.config.reservationGraceMs;
    await this.deps.db.updateTable('agents').set({ endedAt: this.deps.clock.now() }).where('endedAt', 'is', null).where('lastHeartbeatAt', '<=', endCutoff).execute();
    return stale.length;
  }
}
