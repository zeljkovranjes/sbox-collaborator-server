import type { KnowledgeRow } from '../db/schema.js';
import { invalid, notFound } from '../lib/errors.js';
import { list, toJson } from '../lib/json.js';
import { matchScore, recency, tokenSet, truncate } from '../lib/relevance.js';
import { iso } from '../lib/time.js';
import type { ActivityService } from './activity.js';
import { canAccessProject, requireProjectAccess, type Actor, type Deps } from './context.js';
import type { Directory } from './directory.js';

export const SUGGESTED_TAGS = ['networking', 'physics', 'rendering', 'shader', 'animation', 'ui', 'audio', 'asset', 'sbox-api', 'bug', 'workaround'];

export interface Knowledge {
  id: number;
  projectId: string | null;
  title: string;
  body: string;
  tags: string[];
  authorId: string;
  authorName: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
}

const cleanTags = (tags: string[] | undefined) => [...new Set((tags ?? []).map((t) => t.trim().toLowerCase().replace(/\s+/g, '-')).filter(Boolean))].slice(0, 12);

export class KnowledgeService {
  constructor(
    private readonly deps: Deps,
    private readonly directory: Directory,
    private readonly activity: ActivityService,
  ) {}

  async view(rows: KnowledgeRow[]): Promise<Knowledge[]> {
    return Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        projectId: row.projectId,
        title: row.title,
        body: row.body,
        tags: list(row.tags),
        authorId: row.authorId,
        authorName: (await this.directory.name(row.authorId)) ?? row.authorId,
        createdAt: iso(row.createdAt)!,
        updatedAt: iso(row.updatedAt)!,
        archived: row.archivedAt != null,
      })),
    );
  }

  async add(actor: Actor, input: { project?: string | null; title: string; body: string; tags?: string[] }): Promise<Knowledge> {
    if (input.project) requireProjectAccess(actor, input.project);
    else if (actor.projectIds !== null) throw invalid('This key is limited to specific projects; pass project');
    if (!input.title.trim() || !input.body.trim()) throw invalid('Knowledge needs a title and a body');
    const now = this.deps.clock.now();
    const row = await this.deps.db
      .insertInto('knowledge')
      .values({
        projectId: input.project ?? null,
        title: truncate(input.title, 200),
        body: truncate(input.body, 6000),
        tags: toJson(cleanTags(input.tags)),
        authorId: actor.developerId,
        agentId: actor.agentId,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const [item] = await this.view([row]);
    if (row.projectId) {
      const activity = await this.activity.record({ projectId: row.projectId, actor, kind: 'knowledge', summary: `noted: ${row.title}`, refType: 'knowledge', refId: row.id, importance: 1 });
      await this.activity.publish('knowledge_added', row.projectId, actor, item, activity);
    }
    return item!;
  }

  async update(actor: Actor, id: number, patch: { title?: string; body?: string; tags?: string[]; archived?: boolean }): Promise<Knowledge> {
    const row = await this.deps.db.selectFrom('knowledge').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) throw notFound(`Knowledge ${id}`);
    if (row.projectId) requireProjectAccess(actor, row.projectId);
    const values: Record<string, unknown> = { updatedAt: this.deps.clock.now() };
    if (patch.title !== undefined) values.title = truncate(patch.title, 200);
    if (patch.body !== undefined) values.body = truncate(patch.body, 6000);
    if (patch.tags !== undefined) values.tags = toJson(cleanTags(patch.tags));
    if (patch.archived !== undefined) values.archivedAt = patch.archived ? this.deps.clock.now() : null;
    const updated = await this.deps.db.updateTable('knowledge').set(values).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    return (await this.view([updated]))[0]!;
  }

  /** Project + global knowledge, ranked by match (title/tags weigh most) and freshness. */
  async search(actor: Actor, filter: { project?: string; query?: string; tags?: string[]; limit?: number }): Promise<Knowledge[]> {
    if (filter.project) requireProjectAccess(actor, filter.project);
    let query = this.deps.db.selectFrom('knowledge').selectAll().where('archivedAt', 'is', null);
    query = filter.project
      ? query.where((eb) => eb.or([eb('projectId', '=', filter.project!), eb('projectId', 'is', null)]))
      : query;
    let rows = (await query.orderBy('updatedAt', 'desc').limit(2000).execute()).filter((r) => !r.projectId || canAccessProject(actor, r.projectId));
    const tags = cleanTags(filter.tags);
    if (tags.length) rows = rows.filter((r) => tags.every((t) => list(r.tags).includes(t)));
    if (filter.query) rows = this.rank(rows, filter.query).filter((x) => x.score > 0).map((x) => x.row);
    return this.view(rows.slice(0, Math.min(filter.limit ?? 10, 50)));
  }

  rank(rows: KnowledgeRow[], text: string): { row: KnowledgeRow; score: number }[] {
    const q = tokenSet(text);
    const now = this.deps.clock.now();
    return rows
      .map((row) => {
        const score = matchScore(q, tokenSet(row.title, list(row.tags).join(' '))) * 2 + matchScore(q, tokenSet(row.body)) * 0.5;
        return { row, score: score > 0 ? score + recency(row.updatedAt, now, 60 * 86_400_000) * 0.5 : 0 };
      })
      .sort((a, b) => b.score - a.score);
  }
}
