import { sql } from 'kysely';
import type { DigestRow } from '../db/schema.js';
import { invalid } from '../lib/errors.js';
import { list, parseJson, toJson } from '../lib/json.js';
import { log } from '../lib/log.js';
import { isDirectoryPath, normalizePath, overlap, pathKey } from '../lib/paths.js';
import { truncate } from '../lib/relevance.js';
import { iso } from '../lib/time.js';
import type { ActivityService } from './activity.js';
import type { AssetService } from './assets.js';
import { requireProjectAccess, type Actor, type Deps } from './context.js';
import type { Directory } from './directory.js';
import type { ProjectService } from './projects.js';
import type { ReservationService } from './reservations.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface SummaryCounts {
  commits: number;
  changes: number;
  breaking: number;
  tasksCompleted: number;
  tasksClaimed: number;
  decisions: number;
  knowledge: number;
  messages: number;
  failedTests: number;
}

export interface CatchUp {
  since: string;
  until: string;
  summary: string;
  counts: SummaryCounts;
}

export interface Digest {
  id: number | null;
  projectId: string;
  from: string;
  to: string;
  summary: string;
  stats: SummaryCounts & { people: Record<string, number> };
  createdAt: string | null;
}

/** "3h", "2 days" – how long a window is. */
function span(ms: number): string {
  if (ms < 2 * HOUR) return `${Math.max(1, Math.round(ms / 60_000))} min`;
  if (ms < 2 * DAY) return `${Math.round(ms / HOUR)} h`;
  return `${Math.round(ms / DAY)} days`;
}

/**
 * Deterministic, compact write-ups of what happened in a project over a window: the personal
 * "catch me up" (others' work since you last looked, plus what needs you) and the team digest.
 */
export class SummaryService {
  constructor(
    private readonly deps: Deps,
    private readonly directory: Directory,
    private readonly activity: ActivityService,
    private readonly projects: ProjectService,
    private readonly reservations: ReservationService,
    private readonly assets: AssetService,
  ) {}

  private async gather(projectId: string, from: number, to: number, exclude: string | null) {
    const db = this.deps.db;
    const [commits, changes, completed, claimed, blocked, decisions, knowledge, tests, handoffs] = await Promise.all([
      db.selectFrom('commits').selectAll().where('projectId', '=', projectId).where('pushedAt', '>=', from).where('pushedAt', '<', to).orderBy('at', 'desc').limit(500).execute(),
      db.selectFrom('changes').selectAll().where('projectId', '=', projectId).where('status', '=', 'completed').where('completedAt', '>=', from).where('completedAt', '<', to).orderBy('completedAt', 'desc').limit(200).execute(),
      db.selectFrom('tasks').selectAll().where('projectId', '=', projectId).where('status', '=', 'done').where('completedAt', '>=', from).where('completedAt', '<', to).orderBy('completedAt', 'desc').limit(100).execute(),
      db.selectFrom('tasks').selectAll().where('projectId', '=', projectId).where('status', 'in', ['claimed', 'in_progress', 'review']).where('claimedAt', '>=', from).orderBy('claimedAt', 'desc').limit(50).execute(),
      db.selectFrom('tasks').selectAll().where('projectId', '=', projectId).where('status', '=', 'blocked').limit(20).execute(),
      db.selectFrom('decisions').selectAll().where('projectId', '=', projectId).where('createdAt', '>=', from).where('createdAt', '<', to).orderBy('createdAt', 'desc').limit(30).execute(),
      db.selectFrom('knowledge').selectAll().where('projectId', '=', projectId).where('createdAt', '>=', from).where('createdAt', '<', to).orderBy('createdAt', 'desc').limit(30).execute(),
      db.selectFrom('testRuns').selectAll().where('projectId', '=', projectId).where('startedAt', '>=', from).where('startedAt', '<', to).where('status', 'in', ['failed', 'error']).orderBy('startedAt', 'desc').limit(50).execute(),
      db.selectFrom('taskNotes').selectAll().where('projectId', '=', projectId).where('kind', '=', 'handoff').where('createdAt', '>=', from).where('createdAt', '<', to).orderBy('createdAt', 'desc').limit(30).execute(),
    ]);
    const others = <T>(rows: T[], who: (row: T) => string | null) => (exclude ? rows.filter((r) => who(r) !== exclude) : rows);
    return {
      commits: others(commits, (c) => c.developerId),
      changes: others(changes, (c) => c.developerId),
      completed: others(completed, (t) => t.ownerId),
      claimed: others(claimed, (t) => t.ownerId),
      blocked,
      decisions: others(decisions, (d) => d.authorId),
      knowledge: others(knowledge, (k) => k.authorId),
      tests,
      handoffs,
    };
  }

  async #render(projectId: string, data: Awaited<ReturnType<SummaryService['gather']>>, header: string, forDeveloper: string | null, now: number) {
    const name = async (id: string | null | undefined, fallback?: string | null) => (id ? ((await this.directory.name(id)) ?? id) : (fallback ?? 'someone'));
    const lines: string[] = [];
    const breaking = data.changes.filter((c) => list(c.breakingChanges).length > 0 || list(c.apisRemoved).length > 0 || parseJson<unknown[]>(c.apisRenamed, []).length > 0);
    const counts: SummaryCounts = {
      commits: data.commits.length,
      changes: data.changes.length,
      breaking: breaking.length,
      tasksCompleted: data.completed.length,
      tasksClaimed: data.claimed.length,
      decisions: data.decisions.length,
      knowledge: data.knowledge.length,
      messages: 0,
      failedTests: data.tests.length,
    };
    lines.push(header);

    // What needs you first.
    if (forDeveloper) {
      const unread = await this.deps.db
        .selectFrom('messages as m')
        .leftJoin('messageReceipts as r', (join) => join.onRef('r.messageId', '=', 'm.id').on('r.developerId', '=', forDeveloper))
        .select(['m.type', 'm.body', 'm.fromDeveloperId', 'm.taskId'])
        .where('m.projectId', '=', projectId)
        .where('r.ackedAt', 'is', null)
        .where('m.fromDeveloperId', '!=', forDeveloper)
        .where((eb) => eb.or([eb('m.toDeveloperId', '=', forDeveloper), eb('m.toDeveloperId', 'is', null)]))
        .where('m.createdAt', '>', now - 14 * DAY)
        .orderBy('m.createdAt', 'desc')
        .limit(20)
        .execute();
      const mine = data.handoffs.filter((h) => h.toDeveloperId === forDeveloper);
      // A handoff already listed from its note does not need its message repeated.
      const handedTasks = new Set(mine.map((h) => h.taskId));
      const pending = unread.filter((m) => !(m.type === 'handoff' && m.taskId != null && handedTasks.has(m.taskId)));
      counts.messages = unread.length;
      if (pending.length || mine.length) {
        lines.push('', '### Needs you');
        for (const h of mine) {
          const task = await this.deps.db.selectFrom('tasks').select(['id', 'title']).where('id', '=', h.taskId).executeTakeFirst();
          lines.push(`- Handed to you: #${h.taskId} ${task?.title ?? ''} (from ${await name(h.authorId)}): ${truncate(h.summary, 160)}${h.next ? ` → next: ${truncate(h.next, 120)}` : ''}`);
        }
        for (const m of pending.slice(0, 5)) lines.push(`- ${m.type} from ${await name(m.fromDeveloperId)}: ${truncate(m.body, 160)}`);
        if (pending.length > 5) lines.push(`- …${pending.length - 5} more unread message(s)`);
      }
    }

    if (breaking.length) {
      lines.push('', '### Breaking and API changes');
      for (const c of breaking.slice(0, 6)) {
        const api = [...list(c.apisAdded).map((a) => `+${a}`), ...list(c.apisRemoved).map((a) => `-${a}`), ...parseJson<{ from: string; to: string }[]>(c.apisRenamed, []).map((r) => `${r.from}→${r.to}`)];
        lines.push(`- ${await name(c.developerId)}: ${truncate(c.summary, 140)}${api.length ? ` (${truncate(api.join(', '), 140)})` : ''}${list(c.breakingChanges).length ? ` – ${truncate(list(c.breakingChanges).join('; '), 160)}` : ''}`);
      }
    }

    const failing = data.tests.filter((t, i) => data.tests.findIndex((u) => (u.branch ?? '') === (t.branch ?? '') && u.build === t.build) === i);
    if (failing.length) {
      lines.push('', '### Build and tests');
      for (const t of failing.slice(0, 5)) {
        const firstError = list(t.errors)[0];
        lines.push(`- ${t.status.toUpperCase()}: ${t.description}${t.branch ? ` on ${t.branch}` : ''}${t.commitSha ? ` @${t.commitSha.slice(0, 7)}` : ''} (${await name(t.developerId)})${firstError ? ` – ${truncate(firstError, 120)}` : ''}`);
      }
    }

    const otherChanges = data.changes.filter((c) => !breaking.includes(c));
    if (data.completed.length || otherChanges.length) {
      lines.push('', '### Done');
      for (const t of data.completed.slice(0, 8)) lines.push(`- #${t.id} ${t.title} – ${await name(t.ownerId)}${t.completionSummary ? `: ${truncate(t.completionSummary, 120)}` : ''}`);
      for (const c of otherChanges.slice(0, 6)) lines.push(`- ${await name(c.developerId)}: ${truncate(c.summary, 140)}`);
      if (data.completed.length > 8) lines.push(`- …${data.completed.length - 8} more task(s)`);
    }

    if (data.claimed.length || data.blocked.length) {
      lines.push('', '### Now in progress');
      for (const t of data.claimed.slice(0, 8)) lines.push(`- #${t.id} ${t.title} – ${await name(t.ownerId)}${t.branch ? ` @${t.branch}` : ''}`);
      for (const t of data.blocked.slice(0, 5)) lines.push(`- BLOCKED #${t.id} ${t.title} – ${await name(t.ownerId)}: ${truncate(t.blockedReason, 120)}`);
    }

    if (data.commits.length) {
      lines.push('', '### Commits');
      const groups = new Map<string, typeof data.commits>();
      for (const c of data.commits) {
        const key = `${c.developerId ?? c.authorLogin ?? c.authorName ?? '?'}\u0000${c.branch ?? ''}`;
        groups.set(key, [...(groups.get(key) ?? []), c]);
      }
      for (const [key, commits] of [...groups.entries()].slice(0, 8)) {
        const [who, branch] = key.split('\u0000');
        const latest = commits[0]!;
        lines.push(`- ${await name(latest.developerId, who)}: ${commits.length} commit${commits.length === 1 ? '' : 's'}${branch ? ` on ${branch}` : ''} (latest ${latest.sha.slice(0, 7)} "${truncate(latest.message.split('\n')[0], 80)}")`);
      }
    }

    if (data.decisions.length || data.knowledge.length) {
      lines.push('', '### Decisions and knowledge');
      for (const d of data.decisions.slice(0, 5)) lines.push(`- Decision D${d.id}: ${d.title} – ${truncate(d.decision, 140)}`);
      for (const k of data.knowledge.slice(0, 5)) lines.push(`- Knowledge K${k.id}: ${k.title}`);
    }

    const quiet = Object.entries(counts).every(([key, value]) => key === 'messages' || value === 0) && counts.messages === 0;
    if (quiet) lines.push('', 'Nothing new from the team.');
    return { summary: lines.join('\n'), counts };
  }

  /** What changed while you were away (others' work) and what needs you. Moves your marker. */
  async catchUp(actor: Actor, projectId: string, sinceOverride?: number): Promise<CatchUp> {
    requireProjectAccess(actor, projectId);
    await this.projects.row(projectId);
    const now = this.deps.clock.now();
    const mark = await this.deps.db.selectFrom('catchUpMarks').select('at').where('developerId', '=', actor.developerId).where('projectId', '=', projectId).executeTakeFirst();
    const since = Math.max(sinceOverride ?? mark?.at ?? now - 3 * DAY, now - 14 * DAY);
    const data = await this.gather(projectId, since, now + 1, actor.developerId);
    const header = `**Since ${new Date(since).toISOString().slice(0, 16).replace('T', ' ')} UTC (${span(now - since)})**`;
    const { summary, counts } = await this.#render(projectId, data, header, actor.developerId, now);
    if (mark) await this.deps.db.updateTable('catchUpMarks').set({ at: now }).where('developerId', '=', actor.developerId).where('projectId', '=', projectId).execute();
    else await this.deps.db.insertInto('catchUpMarks').values({ developerId: actor.developerId, projectId, at: now }).execute();
    return { since: iso(since)!, until: iso(now)!, summary, counts };
  }

  /** Team-wide write-up of the last `days` days (not stored). */
  async digest(actor: Actor | null, projectId: string, days = 7): Promise<Digest> {
    if (actor) requireProjectAccess(actor, projectId);
    if (days < 1 || days > 31) throw invalid('days must be 1–31');
    const project = await this.projects.row(projectId);
    const to = this.deps.clock.now();
    const from = to - days * DAY;
    const data = await this.gather(projectId, from, to + 1, null);
    const header = `**${project.name} – ${days === 7 ? 'week' : `${days} days`} to ${new Date(to).toISOString().slice(0, 10)}**`;
    const { summary, counts } = await this.#render(projectId, data, header, null, to);
    const people: Record<string, number> = {};
    for (const c of data.commits) {
      const who = (await this.directory.name(c.developerId)) ?? c.authorLogin ?? c.authorName ?? '?';
      people[who] = (people[who] ?? 0) + 1;
    }
    return { id: null, projectId, from: iso(from)!, to: iso(to)!, summary, stats: { ...counts, people }, createdAt: null };
  }

  #digestView(row: DigestRow): Digest {
    return {
      id: row.id,
      projectId: row.projectId,
      from: iso(row.fromAt)!,
      to: iso(row.toAt)!,
      summary: row.summary,
      stats: parseJson(row.stats, { commits: 0, changes: 0, breaking: 0, tasksCompleted: 0, tasksClaimed: 0, decisions: 0, knowledge: 0, messages: 0, failedTests: 0, people: {} }),
      createdAt: iso(row.createdAt),
    };
  }

  async listDigests(actor: Actor, projectId: string, limit = 10): Promise<Digest[]> {
    requireProjectAccess(actor, projectId);
    const rows = await this.deps.db.selectFrom('digests').selectAll().where('projectId', '=', projectId).orderBy('createdAt', 'desc').limit(Math.min(limit, 52)).execute();
    return rows.map((r) => this.#digestView(r));
  }

  /** Stores this week's digest for every project once the configured slot has passed (sweeper). */
  async weeklyDigests(): Promise<number> {
    const { digestWeekday, digestHour } = this.deps.config;
    if (digestWeekday < 0) return 0;
    const now = new Date(this.deps.clock.now());
    const slot = new Date(now);
    slot.setHours(digestHour, 0, 0, 0);
    slot.setDate(slot.getDate() - ((slot.getDay() - digestWeekday + 7) % 7));
    if (slot.getTime() > now.getTime()) slot.setDate(slot.getDate() - 7);
    let created = 0;
    const projects = await this.deps.db.selectFrom('projects').select('id').where('archivedAt', 'is', null).execute();
    for (const { id } of projects) {
      const existing = await this.deps.db.selectFrom('digests').select('id').where('projectId', '=', id).where('createdAt', '>=', slot.getTime()).executeTakeFirst();
      if (existing) continue;
      try {
        const digest = await this.digest(null, id, 7);
        const row = await this.deps.db
          .insertInto('digests')
          .values({ projectId: id, fromAt: Date.parse(digest.from), toAt: Date.parse(digest.to), summary: digest.summary, stats: toJson(digest.stats), createdAt: this.deps.clock.now() })
          .returningAll()
          .executeTakeFirstOrThrow();
        const view = this.#digestView(row);
        const activity = await this.activity.record({ projectId: id, actor: null, kind: 'digest', summary: `weekly digest: ${digest.stats.commits} commits, ${digest.stats.tasksCompleted} tasks done, ${digest.stats.changes} changes`, refType: 'digest', refId: row.id, importance: 1 });
        await this.activity.publish('digest_created', id, null, view, activity);
        created++;
      } catch (error) {
        log.warn('weekly digest failed', { project: id, error: (error as Error).message });
      }
    }
    return created;
  }

  /** Who touched a file or folder, when and why. */
  async history(actor: Actor, projectId: string, rawPath: string, limit = 20) {
    requireProjectAccess(actor, projectId);
    const path = normalizePath(rawPath);
    const key = pathKey(path);
    const dir = isDirectoryPath(path);
    // JSON arrays of paths are stored as text: match the quoted path (or folder prefix).
    const pattern = dir ? `%"${key.replace(/[%_]/g, '')}%` : `%"${key.replace(/[%_]/g, '')}"%`;
    const commits = await this.deps.db
      .selectFrom('commits')
      .selectAll()
      .where('projectId', '=', projectId)
      .where((eb) => eb.or([eb(sql`lower(added)`, 'like', pattern), eb(sql`lower(modified)`, 'like', pattern), eb(sql`lower(removed)`, 'like', pattern)]))
      .orderBy('at', 'desc')
      .limit(Math.min(limit, 100))
      .execute();
    const touches = (files: string[]) => files.some((f) => {
      try {
        return overlap(pathKey(f), key) !== null;
      } catch {
        return false;
      }
    });
    const changes = (await this.deps.db
      .selectFrom('changes')
      .selectAll()
      .where('projectId', '=', projectId)
      .where('status', '=', 'completed')
      .where(sql`lower(files)`, 'like', pattern)
      .orderBy('completedAt', 'desc')
      .limit(20)
      .execute()).filter((c) => touches(list(c.files)));
    const tasks = (await this.deps.db
      .selectFrom('tasks')
      .selectAll()
      .where('projectId', '=', projectId)
      .where('status', '!=', 'done')
      .where(sql`lower(related_files)`, 'like', pattern)
      .limit(20)
      .execute()).filter((t) => touches(list(t.relatedFiles)));
    let asset = null;
    if (!dir) {
      try {
        asset = (await this.assets.get(actor, projectId, path)).asset;
      } catch {
        asset = null;
      }
    }
    return {
      path,
      commits: await Promise.all(
        commits.map(async (c) => {
          const kind = (files: string) => list(files).some((f) => { try { return overlap(pathKey(f), key) !== null; } catch { return false; } });
          return {
            sha: c.sha,
            shortSha: c.sha.slice(0, 7),
            message: c.message.split('\n')[0],
            author: (await this.directory.name(c.developerId)) ?? c.authorLogin ?? c.authorName,
            developerId: c.developerId,
            at: iso(c.at),
            branch: c.branch,
            taskId: c.taskId,
            url: c.url,
            change: kind(c.added) ? 'added' : kind(c.removed) ? 'removed' : 'modified',
          };
        }),
      ),
      changes: await Promise.all(
        changes.map(async (c) => ({
          id: c.id,
          summary: c.summary,
          developerName: (await this.directory.name(c.developerId)) ?? c.developerId,
          completedAt: iso(c.completedAt),
          breaking: list(c.breakingChanges).length > 0 || list(c.apisRemoved).length > 0,
          taskId: c.taskId,
        })),
      ),
      tasks: await Promise.all(tasks.map(async (t) => ({ id: t.id, title: t.title, status: t.status, ownerName: await this.directory.name(t.ownerId) }))),
      reservations: await this.reservations.list(actor, projectId, { path }),
      asset,
    };
  }
}
