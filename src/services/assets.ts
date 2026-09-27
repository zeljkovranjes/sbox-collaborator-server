import type { Db, Tx } from '../db/index.js';
import type { AssetRow } from '../db/schema.js';
import { invalid, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { list, parseJson, toJson } from '../lib/json.js';
import { normalizePath, pathKey } from '../lib/paths.js';
import { matchScore, tokenSet, truncate } from '../lib/relevance.js';
import { ASSET_TYPES, assetTypeOf, extractReferences, isTrackedAsset, nameOf } from '../lib/sbox.js';
import { iso } from '../lib/time.js';
import type { ActivityService } from './activity.js';
import { requireProjectAccess, type Actor, type Deps } from './context.js';
import type { Directory } from './directory.js';
import type { ProjectService } from './projects.js';
import type { Reservation, ReservationService } from './reservations.js';

export interface Asset {
  path: string;
  type: string;
  name: string;
  description: string | null;
  tags: string[];
  metadata: Record<string, unknown>;
  source: string;
  lastCommitSha: string | null;
  lastChangedBy: string | null;
  lastChangedByName: string | null;
  lastChangedAt: string | null;
  updatedAt: string;
  deleted: boolean;
}

export interface AssetTreeNode {
  path: string;
  type: string;
  known: boolean;
  children?: AssetTreeNode[];
  /** Already shown higher up in the tree. */
  repeated?: boolean;
}

export interface AssetInput {
  path: string;
  description?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  dependencies?: string[];
  content?: string;
}

const MAX_TREE_NODES = 300;

export class AssetService {
  constructor(
    private readonly deps: Deps,
    private readonly directory: Directory,
    private readonly activity: ActivityService,
    private readonly projects: ProjectService,
    private readonly reservations: ReservationService,
  ) {}

  async view(rows: AssetRow[]): Promise<Asset[]> {
    return Promise.all(
      rows.map(async (row) => ({
        path: row.path,
        type: row.type,
        name: row.name,
        description: row.description,
        tags: list(row.tags),
        metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
        source: row.source,
        lastCommitSha: row.lastCommitSha,
        lastChangedBy: row.lastChangedBy,
        lastChangedByName: await this.directory.name(row.lastChangedBy),
        lastChangedAt: iso(row.lastChangedAt),
        updatedAt: iso(row.updatedAt)!,
        deleted: row.deletedAt != null,
      })),
    );
  }

  async #row(executor: Db | Tx, projectId: string, path: string): Promise<AssetRow | undefined> {
    return executor.selectFrom('assets').selectAll().where('projectId', '=', projectId).where('pathKey', '=', pathKey(path)).executeTakeFirst();
  }

  /** Inserts or updates one asset and (when given) replaces its outgoing references. */
  async #upsert(executor: Db | Tx, projectId: string, input: AssetInput, source: string, changedBy: string | null): Promise<AssetRow> {
    const path = normalizePath(input.path);
    if (path.endsWith('/')) throw invalid('An asset is a file, not a directory');
    const key = path.toLowerCase();
    const now = this.deps.clock.now();
    const existing = await this.#row(executor, projectId, path);
    let dependencies = input.dependencies;
    if (input.content !== undefined) dependencies = [...new Set([...(dependencies ?? []), ...extractReferences(input.content)])];

    let row: AssetRow;
    if (existing) {
      const values: Record<string, unknown> = { updatedAt: now, deletedAt: null, path };
      if (input.description !== undefined) values.description = truncate(input.description, 1000);
      if (input.tags !== undefined) values.tags = toJson(input.tags.map((t) => t.toLowerCase()).slice(0, 20));
      if (input.metadata !== undefined) values.metadata = toJson({ ...parseJson<Record<string, unknown>>(existing.metadata, {}), ...input.metadata });
      if (changedBy) {
        values.lastChangedBy = changedBy;
        values.lastChangedAt = now;
      }
      row = await executor.updateTable('assets').set(values).where('id', '=', existing.id).returningAll().executeTakeFirstOrThrow();
    } else {
      row = await executor
        .insertInto('assets')
        .values({
          id: `as_${newId(12)}`,
          projectId,
          path,
          pathKey: key,
          type: assetTypeOf(path),
          name: nameOf(path),
          description: input.description ? truncate(input.description, 1000) : null,
          tags: toJson((input.tags ?? []).map((t) => t.toLowerCase()).slice(0, 20)),
          metadata: toJson(input.metadata ?? {}),
          source,
          lastCommitSha: null,
          lastChangedBy: changedBy,
          lastChangedAt: changedBy ? now : null,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    }
    if (dependencies !== undefined) await this.#setLinks(executor, projectId, key, dependencies, source);
    return row;
  }

  async #setLinks(executor: Db | Tx, projectId: string, fromKey: string, dependencies: string[], source: string) {
    await executor.deleteFrom('assetLinks').where('projectId', '=', projectId).where('fromKey', '=', fromKey).execute();
    const seen = new Set<string>();
    const rows = [];
    for (const raw of dependencies) {
      let path: string;
      try {
        path = normalizePath(raw);
      } catch {
        continue;
      }
      const key = path.toLowerCase();
      if (key === fromKey || seen.has(key)) continue;
      seen.add(key);
      rows.push({ projectId, fromKey, toKey: key, toPath: path, source });
    }
    for (let i = 0; i < rows.length; i += 200) await executor.insertInto('assetLinks').values(rows.slice(i, i + 200)).execute();
  }

  async register(actor: Actor, projectId: string, input: AssetInput): Promise<Asset> {
    requireProjectAccess(actor, projectId);
    await this.projects.row(projectId);
    const row = await this.deps.db.transaction().execute((trx) => this.#upsert(trx, projectId, input, 'agent', actor.developerId));
    const [asset] = await this.view([row]);
    await this.activity.publish('asset_changed', projectId, actor, { assets: [asset] });
    return asset!;
  }

  async update(actor: Actor, projectId: string, input: AssetInput): Promise<Asset> {
    requireProjectAccess(actor, projectId);
    if (!(await this.#row(this.deps.db, projectId, input.path))) throw notFound(`Asset ${input.path} (register it first)`);
    return this.register(actor, projectId, input);
  }

  async get(actor: Actor, projectId: string, path: string) {
    requireProjectAccess(actor, projectId);
    const row = await this.#row(this.deps.db, projectId, path);
    const key = pathKey(path);
    const [dependencies, references, reservations] = await Promise.all([
      this.deps.db.selectFrom('assetLinks').select(['toPath', 'toKey']).where('projectId', '=', projectId).where('fromKey', '=', key).execute(),
      this.deps.db
        .selectFrom('assetLinks as l')
        .leftJoin('assets as a', (join) => join.onRef('a.projectId', '=', 'l.projectId').onRef('a.pathKey', '=', 'l.fromKey'))
        .select(['l.fromKey', 'a.path'])
        .where('l.projectId', '=', projectId)
        .where('l.toKey', '=', key)
        .execute(),
      this.reservations.list(actor, projectId, { path }),
    ]);
    if (!row && !dependencies.length && !references.length) throw notFound(`Asset ${path}`);
    const asset = row ? (await this.view([row]))[0]! : null;
    return {
      asset: asset ?? { path: normalizePath(path), type: assetTypeOf(path), name: nameOf(path), known: false },
      dependencies: dependencies.map((d) => ({ path: d.toPath, type: assetTypeOf(d.toPath) })),
      references: references.map((r) => ({ path: r.path ?? r.fromKey, type: assetTypeOf(r.path ?? r.fromKey) })),
      reservedBy: reservations.map((r: Reservation) => ({ developer: r.developerName, agent: r.agentLabel, path: r.path, taskId: r.taskId, reason: r.reason, expiresAt: r.expiresAt })),
    };
  }

  async search(actor: Actor, projectId: string, filter: { query?: string; type?: string; tag?: string; limit?: number }): Promise<Asset[]> {
    requireProjectAccess(actor, projectId);
    if (filter.type && !(ASSET_TYPES as readonly string[]).includes(filter.type)) throw invalid(`Unknown asset type "${filter.type}". Types: ${ASSET_TYPES.join(', ')}`);
    let query = this.deps.db.selectFrom('assets').selectAll().where('projectId', '=', projectId).where('deletedAt', 'is', null);
    if (filter.type) query = query.where('type', '=', filter.type);
    const words = [...tokenSet(filter.query)];
    if (words.length) query = query.where((eb) => eb.or(words.map((w) => eb('pathKey', 'like', `%${w.replace(/[%_]/g, '')}%`))));
    let rows = await query.orderBy('updatedAt', 'desc').limit(2000).execute();
    if (filter.tag) rows = rows.filter((r) => list(r.tags).includes(filter.tag!.toLowerCase()));
    if (filter.query) {
      const q = tokenSet(filter.query);
      const needle = filter.query.trim().toLowerCase();
      rows = rows
        .map((row) => ({ row, score: matchScore(q, tokenSet(row.path, row.description, list(row.tags).join(' '))) + (row.pathKey.includes(needle) ? 3 : 0) + (row.name.toLowerCase().startsWith(needle) ? 2 : 0) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((x) => x.row);
    }
    return this.view(rows.slice(0, Math.min(filter.limit ?? 25, 200)));
  }

  async #tree(projectId: string, path: string, depth: number, direction: 'down' | 'up'): Promise<AssetTreeNode> {
    const maxDepth = Math.max(1, Math.min(depth, 6));
    const known = new Map<string, AssetRow>();
    const seen = new Set<string>();
    let count = 0;
    const load = async (key: string) => {
      if (!known.has(key)) {
        const row = await this.deps.db.selectFrom('assets').selectAll().where('projectId', '=', projectId).where('pathKey', '=', key).executeTakeFirst();
        if (row) known.set(key, row);
      }
      return known.get(key);
    };
    const walk = async (key: string, displayPath: string, level: number): Promise<AssetTreeNode> => {
      count++;
      const row = await load(key);
      const node: AssetTreeNode = { path: row?.path ?? displayPath, type: row?.type ?? assetTypeOf(displayPath), known: !!row && row.deletedAt == null };
      if (seen.has(key)) return { ...node, repeated: true };
      seen.add(key);
      if (level >= maxDepth || count >= MAX_TREE_NODES) return node;
      const next =
        direction === 'down'
          ? (await this.deps.db.selectFrom('assetLinks').select(['toKey as key', 'toPath as path']).where('projectId', '=', projectId).where('fromKey', '=', key).execute())
          : (await this.deps.db
              .selectFrom('assetLinks as l')
              .leftJoin('assets as a', (join) => join.onRef('a.projectId', '=', 'l.projectId').onRef('a.pathKey', '=', 'l.fromKey'))
              .select(['l.fromKey as key', 'a.path as path'])
              .where('l.projectId', '=', projectId)
              .where('l.toKey', '=', key)
              .execute()).map((r) => ({ key: r.key, path: r.path ?? r.key }));
      if (next.length) {
        node.children = [];
        for (const child of next) {
          if (count >= MAX_TREE_NODES) break;
          node.children.push(await walk(child.key, child.path, level + 1));
        }
      }
      return node;
    };
    return walk(pathKey(path), normalizePath(path), 0);
  }

  async dependencies(actor: Actor, projectId: string, path: string, depth = 3): Promise<AssetTreeNode> {
    requireProjectAccess(actor, projectId);
    return this.#tree(projectId, path, depth, 'down');
  }

  async references(actor: Actor, projectId: string, path: string, depth = 2): Promise<AssetTreeNode> {
    requireProjectAccess(actor, projectId);
    return this.#tree(projectId, path, depth, 'up');
  }

  async recentChanges(actor: Actor, projectId: string, filter: { limit?: number; type?: string } = {}): Promise<Asset[]> {
    requireProjectAccess(actor, projectId);
    let query = this.deps.db.selectFrom('assets').selectAll().where('projectId', '=', projectId).where('lastChangedAt', 'is not', null);
    if (filter.type) query = query.where('type', '=', filter.type);
    return this.view(await query.orderBy('lastChangedAt', 'desc').limit(Math.min(filter.limit ?? 25, 100)).execute());
  }

  /** Editor scan upload: many assets with their real engine references in one transaction. */
  async bulk(
    actor: Actor,
    projectId: string,
    input: { assets: { path: string; dependencies?: string[]; metadata?: Record<string, unknown> }[]; removed?: string[]; fullScan?: boolean },
  ): Promise<{ upserted: number; links: number; removed: number }> {
    requireProjectAccess(actor, projectId);
    await this.projects.row(projectId);
    if (input.assets.length > 20_000) throw invalid('At most 20000 assets per upload');
    let links = 0;
    let removed = 0;
    const reported = new Set<string>();
    await this.deps.db.transaction().execute(async (trx) => {
      const now = this.deps.clock.now();
      const existing = new Map<string, AssetRow>();
      for (const row of await trx.selectFrom('assets').selectAll().where('projectId', '=', projectId).execute()) existing.set(row.pathKey, row);
      const inserts = [];
      for (const item of input.assets) {
        let path: string;
        try {
          path = normalizePath(item.path);
        } catch {
          continue;
        }
        const key = path.toLowerCase();
        if (reported.has(key)) continue;
        reported.add(key);
        const row = existing.get(key);
        if (row) {
          const metadata = item.metadata ? toJson({ ...parseJson<Record<string, unknown>>(row.metadata, {}), ...item.metadata }) : row.metadata;
          if (row.deletedAt != null || metadata !== row.metadata || row.path !== path) {
            await trx.updateTable('assets').set({ deletedAt: null, metadata, path, updatedAt: now }).where('id', '=', row.id).execute();
          }
        } else {
          inserts.push({
            id: `as_${newId(12)}`,
            projectId,
            path,
            pathKey: key,
            type: assetTypeOf(path),
            name: nameOf(path),
            description: null,
            tags: '[]',
            metadata: toJson(item.metadata ?? {}),
            source: 'editor',
            lastCommitSha: null,
            lastChangedBy: null,
            lastChangedAt: null,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
          });
        }
        if (item.dependencies) {
          await this.#setLinks(trx, projectId, key, item.dependencies, 'editor');
          links += item.dependencies.length;
        }
      }
      for (let i = 0; i < inserts.length; i += 200) await trx.insertInto('assets').values(inserts.slice(i, i + 200)).execute();
      const toRemove = new Set<string>();
      for (const raw of input.removed ?? []) {
        try {
          toRemove.add(pathKey(raw));
        } catch {
          /* ignore bad paths */
        }
      }
      if (input.fullScan) {
        for (const [key, row] of existing) if (row.source === 'editor' && row.deletedAt == null && !reported.has(key)) toRemove.add(key);
      }
      const keys = [...toRemove];
      for (let i = 0; i < keys.length; i += 200) {
        const result = await trx
          .updateTable('assets')
          .set({ deletedAt: now, updatedAt: now })
          .where('projectId', '=', projectId)
          .where('pathKey', 'in', keys.slice(i, i + 200))
          .where('deletedAt', 'is', null)
          .executeTakeFirst();
        removed += Number(result.numUpdatedRows ?? 0);
      }
    });
    await this.activity.publish('asset_changed', projectId, actor, { scan: true, upserted: reported.size, removed });
    return { upserted: reported.size, links, removed };
  }

  /** Assets touched by a pushed commit (webhooks). */
  async recordCommit(projectId: string, commit: { sha: string; developerId: string | null; added: string[]; modified: string[]; removed: string[] }): Promise<string[]> {
    const changed = [...commit.added, ...commit.modified].filter(isTrackedAsset);
    const removed = commit.removed.filter(isTrackedAsset);
    if (!changed.length && !removed.length) return [];
    await this.deps.db.transaction().execute(async (trx) => {
      const now = this.deps.clock.now();
      for (const path of changed) {
        const row = await this.#upsert(trx, projectId, { path }, 'git', commit.developerId);
        await trx.updateTable('assets').set({ lastCommitSha: commit.sha, lastChangedAt: now, lastChangedBy: commit.developerId }).where('id', '=', row.id).execute();
      }
      for (const path of removed) {
        await trx
          .updateTable('assets')
          .set({ deletedAt: now, lastCommitSha: commit.sha, lastChangedAt: now, lastChangedBy: commit.developerId })
          .where('projectId', '=', projectId)
          .where('pathKey', '=', pathKey(path))
          .execute();
      }
    });
    return [...changed, ...removed];
  }
}
