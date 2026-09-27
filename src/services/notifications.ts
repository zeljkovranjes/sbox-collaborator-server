import type { CollabEvent } from '../events/bus.js';
import { errorFields, log } from '../lib/log.js';
import { truncate } from '../lib/relevance.js';
import type { Activity } from './activity.js';
import type { Deps } from './context.js';
import type { Directory } from './directory.js';
import type { Message } from './messages.js';
import type { ProjectService } from './projects.js';
import type { Digest } from './summary.js';
import type { Task, TaskNote } from './tasks.js';

interface Outgoing {
  url: string;
  content: string;
  attempts: number;
}

/** Activity kinds worth a ping: things that need a person, not the regular feed. */
const PING_KINDS = new Set(['blocker', 'build_failed', 'conflict', 'breaking_change']);
const ICON: Record<string, string> = { blocker: '🛑', build_failed: '❌', conflict: '⚠️', breaking_change: '💥', handoff: '🤝', message: '💬', digest: '🗒️' };
const MESSAGE_TYPES = new Set(['blocker', 'warning', 'handoff', 'request', 'question']);

/**
 * Forwards the events that need a person to Discord (per-project webhook, else the server
 * default): blockers, broken builds, pushes over reservations, breaking changes, handoffs, direct
 * messages that need attention, and the weekly digest. Queued, rate-limited, retried on 429.
 */
export class DiscordNotifier {
  #queue: Outgoing[] = [];
  #sending = false;
  #recent = new Map<string, number>();
  #unsubscribe: (() => void) | null = null;

  constructor(
    private readonly deps: Deps,
    private readonly directory: Directory,
    private readonly projects: ProjectService,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  start(): void {
    this.#unsubscribe ??= this.deps.bus.subscribe((event) => {
      void this.#handle(event).catch((error) => log.warn('discord notification failed', errorFields(error)));
    });
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }

  async #mention(developerId: string | null | undefined): Promise<string> {
    const developer = await this.directory.get(developerId);
    if (!developer) return developerId ?? 'someone';
    return developer.discordUserId ? `<@${developer.discordUserId}>` : `**${developer.displayName}**`;
  }

  /** Builds the Discord line for an event, or null when it is not worth a ping. */
  async format(event: CollabEvent): Promise<string | null> {
    switch (event.type) {
      case 'activity': {
        const a = event.data as Activity | null;
        if (!a || !PING_KINDS.has(a.kind)) return null;
        const who = a.actorName && !a.summary.startsWith(a.actorName) ? `**${a.actorName}** ` : '';
        return `${ICON[a.kind] ?? '•'} ${who}${truncate(a.summary, 900)}`;
      }
      case 'task_handoff': {
        const { task, note } = event.data as { task: Task; note: TaskNote | null };
        if (!note) return null;
        const to = note.toDeveloperId ? ` to ${await this.#mention(note.toDeveloperId)}` : ' back to the board';
        const next = note.next ? `\n> next: ${truncate(note.next, 400)}` : '';
        return `${ICON.handoff} **${note.authorName}** handed off #${task.id} "${truncate(task.title, 120)}"${to}\n> ${truncate(note.summary, 600)}${next}`;
      }
      case 'message_received': {
        const m = event.data as Message;
        if (!m || m.broadcast || !MESSAGE_TYPES.has(m.type) || !m.toDeveloperId) return null;
        return `${ICON.message} ${m.type} from **${m.fromName}** to ${await this.#mention(m.toDeveloperId)}: ${truncate(m.body, 900)}`;
      }
      case 'digest_created': {
        const d = event.data as Digest;
        return `${ICON.digest} Weekly digest\n${truncate(d.summary, 1700)}`;
      }
      default:
        return null;
    }
  }

  async #handle(event: CollabEvent): Promise<void> {
    const content = await this.format(event);
    if (!content) return;
    const url = await this.projects.discordWebhook(event.projectId);
    if (!url) return;
    // Drop exact repeats within 10 minutes (e.g. a flapping editor compile).
    const key = `${event.projectId}\u0000${content}`;
    const now = this.deps.clock.now();
    if ((this.#recent.get(key) ?? 0) > now - 10 * 60_000) return;
    this.#recent.set(key, now);
    if (this.#recent.size > 500) for (const [k, at] of this.#recent) if (at < now - 10 * 60_000) this.#recent.delete(k);
    this.#queue.push({ url, content: truncate(content, 1990), attempts: 0 });
    void this.#drain();
  }

  async #drain(): Promise<void> {
    if (this.#sending) return;
    this.#sending = true;
    try {
      while (this.#queue.length) {
        const next = this.#queue.shift()!;
        const wait = await this.#send(next);
        if (wait > 0) {
          if (next.attempts < 3) this.#queue.unshift({ ...next, attempts: next.attempts + 1 });
          await new Promise((resolve) => setTimeout(resolve, wait));
        } else {
          await new Promise((resolve) => setTimeout(resolve, 1100)); // stay well inside Discord's limits
        }
      }
    } finally {
      this.#sending = false;
    }
  }

  /** Posts one message. Returns how long to wait before retrying (0 = done or given up). */
  async #send(item: Outgoing): Promise<number> {
    try {
      const response = await this.fetchImpl(item.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: item.content, allowed_mentions: { parse: ['users'] }, username: 'Collaborator' }),
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status === 429) {
        const body = (await response.json().catch(() => ({}))) as { retry_after?: number };
        return Math.ceil((body.retry_after ?? 2) * 1000);
      }
      if (!response.ok) log.warn('discord rejected a notification', { status: response.status });
      return 0;
    } catch (error) {
      log.warn('discord unreachable', errorFields(error));
      return item.attempts < 3 ? 5000 : 0;
    }
  }

  /** For tests: resolves when everything queued has been sent. */
  async idle(): Promise<void> {
    while (this.#sending || this.#queue.length) await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
