import type { MessageRow } from '../db/schema.js';
import { AppError, forbidden, invalid, notFound } from '../lib/errors.js';
import { list, toJson } from '../lib/json.js';
import { uniquePaths } from '../lib/paths.js';
import { truncate } from '../lib/relevance.js';
import { iso } from '../lib/time.js';
import type { ActivityService } from './activity.js';
import { requireProjectAccess, type Actor, type Deps } from './context.js';
import type { Directory } from './directory.js';
import type { ProjectService } from './projects.js';

export const MESSAGE_TYPES = ['info', 'question', 'warning', 'blocker', 'request', 'handoff'] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

/** These stay unread until acknowledged; the rest are acknowledged when read. */
const NEEDS_ACK: MessageType[] = ['question', 'blocker', 'request', 'handoff'];

export interface Message {
  id: number;
  projectId: string;
  type: MessageType;
  fromDeveloperId: string;
  fromName: string;
  fromAgentId: string | null;
  toDeveloperId: string | null;
  toAgentId: string | null;
  broadcast: boolean;
  subject: string | null;
  body: string;
  taskId: number | null;
  paths: string[];
  createdAt: string;
  readAt: string | null;
  ackedAt: string | null;
}

export interface SendInput {
  project: string;
  to?: string | null;
  type: MessageType;
  body: string;
  subject?: string;
  taskId?: number;
  paths?: string[];
}

const WINDOW = 10 * 60_000;

export class MessageService {
  constructor(
    private readonly deps: Deps,
    private readonly directory: Directory,
    private readonly activity: ActivityService,
    private readonly projects: ProjectService,
  ) {}

  async #view(rows: MessageRow[], developerId: string): Promise<Message[]> {
    const receipts = new Map<number, { readAt: number | null; ackedAt: number | null }>();
    if (rows.length) {
      const found = await this.deps.db
        .selectFrom('messageReceipts')
        .selectAll()
        .where('developerId', '=', developerId)
        .where('messageId', 'in', rows.map((r) => r.id))
        .execute();
      for (const r of found) receipts.set(r.messageId, r);
    }
    return Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        projectId: row.projectId,
        type: row.type as MessageType,
        fromDeveloperId: row.fromDeveloperId,
        fromName: (await this.directory.name(row.fromDeveloperId)) ?? row.fromDeveloperId,
        fromAgentId: row.fromAgentId,
        toDeveloperId: row.toDeveloperId,
        toAgentId: row.toAgentId,
        broadcast: row.toDeveloperId == null && row.toAgentId == null,
        subject: row.subject,
        body: row.body,
        taskId: row.taskId,
        paths: list(row.paths),
        createdAt: iso(row.createdAt)!,
        readAt: iso(receipts.get(row.id)?.readAt),
        ackedAt: iso(receipts.get(row.id)?.ackedAt),
      })),
    );
  }

  async send(actor: Actor, input: SendInput): Promise<Message> {
    requireProjectAccess(actor, input.project);
    await this.projects.row(input.project);
    if (!MESSAGE_TYPES.includes(input.type)) throw invalid(`Unknown message type "${input.type}"`);
    const body = input.body.trim();
    if (!body) throw invalid('Message body is empty');
    if (body.length > 1000) throw invalid('Keep messages under 1000 characters: say what matters, link the task for detail');

    let toDeveloperId: string | null = null;
    let toAgentId: string | null = null;
    if (input.to) {
      if (input.to.startsWith('ag_')) {
        const agent = await this.deps.db.selectFrom('agents').select(['id', 'developerId', 'projectId']).where('id', '=', input.to).executeTakeFirst();
        if (!agent) throw notFound(`Agent "${input.to}"`);
        toAgentId = agent.id;
        toDeveloperId = agent.developerId;
      } else {
        const developer = (await this.directory.get(input.to)) ?? (await this.directory.byGithubLogin(input.to));
        if (!developer) throw notFound(`Developer "${input.to}"`);
        toDeveloperId = developer.id;
      }
      if (toDeveloperId === actor.developerId && toAgentId === null) throw invalid('That is you – message another developer or a specific agent');
    }

    const now = this.deps.clock.now();
    const recent = await this.deps.db
      .selectFrom('messages')
      .selectAll()
      .where('fromDeveloperId', '=', actor.developerId)
      .where('createdAt', '>', now - WINDOW)
      .execute();
    const duplicate = recent.find((m) => m.body === body && m.toDeveloperId === toDeveloperId && m.toAgentId === toAgentId && m.projectId === input.project);
    if (duplicate) return (await this.#view([duplicate], actor.developerId))[0]!;
    const fromThisSender = recent.filter((m) => (actor.agentId ? m.fromAgentId === actor.agentId : true));
    if (fromThisSender.length >= this.deps.config.messageRateLimit) {
      throw new AppError('rate_limited', `Message limit reached (${this.deps.config.messageRateLimit} per 10 minutes). Put status in agent_set_status / change_complete instead of messages.`);
    }

    const row = await this.deps.db
      .insertInto('messages')
      .values({
        projectId: input.project,
        type: input.type,
        fromDeveloperId: actor.developerId,
        fromAgentId: actor.agentId,
        toDeveloperId,
        toAgentId,
        subject: input.subject ? truncate(input.subject, 120) : null,
        body,
        taskId: input.taskId ?? null,
        paths: toJson(uniquePaths(input.paths ?? [])),
        createdAt: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const message = (await this.#view([row], actor.developerId))[0]!;
    const broadcast = message.broadcast;
    const important = ['warning', 'blocker', 'handoff'].includes(row.type);
    const activity =
      broadcast || important
        ? await this.activity.record({
            projectId: input.project,
            actor,
            kind: 'message',
            summary: `${row.type}${broadcast ? ' to everyone' : ` to ${await this.directory.name(toDeveloperId)}`}: ${truncate(body, 140)}`,
            refType: 'message',
            refId: row.id,
            importance: row.type === 'blocker' ? 3 : important ? 2 : 1,
          })
        : undefined;
    await this.activity.publish('message_received', input.project, actor, message, activity, broadcast ? undefined : [toDeveloperId!, actor.developerId]);
    return message;
  }

  /** Messages for this developer that still need attention (not acknowledged), oldest first. */
  async unread(actor: Actor, projectIds: string[], options: { markRead?: boolean; limit?: number } = {}): Promise<Message[]> {
    if (!projectIds.length) return [];
    const rows = await this.#unreadRows(actor, projectIds, options.limit ?? 30);
    const messages = await this.#view(rows, actor.developerId);
    if (options.markRead !== false && rows.length) {
      const now = this.deps.clock.now();
      for (const row of rows) {
        const autoAck = !NEEDS_ACK.includes(row.type as MessageType);
        await this.#receipt(row.id, actor.developerId, { readAt: now, ...(autoAck ? { ackedAt: now } : {}) });
      }
    }
    return messages;
  }

  async #unreadRows(actor: Actor, projectIds: string[], limit: number): Promise<MessageRow[]> {
    return this.deps.db
      .selectFrom('messages as m')
      .leftJoin('messageReceipts as r', (join) => join.onRef('r.messageId', '=', 'm.id').on('r.developerId', '=', actor.developerId))
      .selectAll('m')
      .where('m.projectId', 'in', projectIds)
      .where('r.ackedAt', 'is', null)
      .where((eb) =>
        eb.or([
          eb.and([eb('m.toDeveloperId', '=', actor.developerId), eb('m.toAgentId', 'is', null)]),
          ...(actor.agentId ? [eb('m.toAgentId', '=', actor.agentId)] : []),
          eb.and([eb('m.toDeveloperId', 'is', null), eb('m.toAgentId', 'is', null), eb('m.fromDeveloperId', '!=', actor.developerId)]),
        ]),
      )
      .where('m.createdAt', '>', this.deps.clock.now() - 14 * 86_400_000)
      .orderBy('m.createdAt', 'asc')
      .limit(limit)
      .execute();
  }

  async unreadSummary(actor: Actor, projectIds: string[]): Promise<{ count: number; urgent: number; latestAt: number | null }> {
    if (!projectIds.length) return { count: 0, urgent: 0, latestAt: null };
    const rows = await this.#unreadRows(actor, projectIds, 100);
    return {
      count: rows.length,
      urgent: rows.filter((r) => ['blocker', 'warning', 'handoff'].includes(r.type)).length,
      latestAt: rows.length ? Math.max(...rows.map((r) => r.createdAt)) : null,
    };
  }

  async #receipt(messageId: number, developerId: string, values: { readAt?: number; ackedAt?: number }) {
    const existing = await this.deps.db.selectFrom('messageReceipts').selectAll().where('messageId', '=', messageId).where('developerId', '=', developerId).executeTakeFirst();
    if (existing) {
      await this.deps.db
        .updateTable('messageReceipts')
        .set({ readAt: existing.readAt ?? values.readAt ?? null, ackedAt: existing.ackedAt ?? values.ackedAt ?? null })
        .where('messageId', '=', messageId)
        .where('developerId', '=', developerId)
        .execute();
    } else {
      await this.deps.db
        .insertInto('messageReceipts')
        .values({ messageId, developerId, readAt: values.readAt ?? values.ackedAt ?? null, ackedAt: values.ackedAt ?? null })
        .execute();
    }
  }

  async acknowledge(actor: Actor, messageIds: number[]): Promise<{ acknowledged: number }> {
    if (!messageIds.length) return { acknowledged: 0 };
    const rows = await this.deps.db.selectFrom('messages').selectAll().where('id', 'in', messageIds).execute();
    const now = this.deps.clock.now();
    let count = 0;
    for (const row of rows) {
      requireProjectAccess(actor, row.projectId);
      const visible = row.toDeveloperId === null || row.toDeveloperId === actor.developerId || row.fromDeveloperId === actor.developerId;
      if (!visible) throw forbidden(`Message ${row.id} is not addressed to you`);
      await this.#receipt(row.id, actor.developerId, { readAt: now, ackedAt: now });
      count++;
    }
    return { acknowledged: count };
  }

  /** Recent conversation visible to this developer (dashboard). */
  async recent(actor: Actor, projectId: string, limit = 50): Promise<Message[]> {
    requireProjectAccess(actor, projectId);
    const rows = await this.deps.db
      .selectFrom('messages')
      .selectAll()
      .where('projectId', '=', projectId)
      .where((eb) =>
        eb.or([
          eb('toDeveloperId', 'is', null),
          eb('toDeveloperId', '=', actor.developerId),
          eb('fromDeveloperId', '=', actor.developerId),
        ]),
      )
      .orderBy('createdAt', 'desc')
      .limit(Math.min(limit, 200))
      .execute();
    return this.#view(rows, actor.developerId);
  }
}
