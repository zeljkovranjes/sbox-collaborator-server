import type { Tx } from '../db/index.js';
import type { ProjectRow } from '../db/schema.js';
import { conflict, invalid, notFound } from '../lib/errors.js';
import { parseJson, toJson } from '../lib/json.js';
import { iso } from '../lib/time.js';
import type { ActivityService } from './activity.js';
import { canAccessProject, requireProjectAccess, type Actor, type Deps } from './context.js';

export interface ImportantDir {
  path: string;
  description: string;
}

export interface Project {
  id: string;
  name: string;
  kind: 'game' | 'library' | 'tool';
  packageIdent: string | null;
  defaultBranch: string;
  repos: { fullName: string; defaultBranch: string | null }[];
  summary: string;
  conventions: string;
  milestone: string;
  importantDirs: ImportantDir[];
  structure: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectInput {
  id: string;
  name: string;
  kind: Project['kind'];
  repos?: string[];
  defaultBranch?: string;
  packageIdent?: string | null;
  summary?: string;
  conventions?: string;
  milestone?: string;
  importantDirs?: ImportantDir[];
  structure?: string;
}

export type ProjectPatch = Partial<Omit<ProjectInput, 'id'>>;

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function parseRepo(fullName: string): { owner: string; name: string } {
  const clean = fullName
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  if (!REPO.test(clean)) throw invalid(`"${fullName}" is not a GitHub repository (use owner/name)`);
  const [owner, name] = clean.split('/') as [string, string];
  return { owner, name };
}

export class ProjectService {
  constructor(
    private readonly deps: Deps,
    private readonly activity: ActivityService,
  ) {}

  async #view(row: ProjectRow): Promise<Project> {
    const repos = await this.deps.db
      .selectFrom('projectRepos')
      .select(['displayName', 'defaultBranch'])
      .where('projectId', '=', row.id)
      .orderBy('displayName')
      .execute();
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      packageIdent: row.packageIdent,
      defaultBranch: row.defaultBranch,
      repos: repos.map((r) => ({ fullName: r.displayName, defaultBranch: r.defaultBranch })),
      summary: row.summary,
      conventions: row.conventions,
      milestone: row.milestone,
      importantDirs: parseJson<ImportantDir[]>(row.importantDirs, []),
      structure: row.structure,
      createdAt: iso(row.createdAt)!,
      updatedAt: iso(row.updatedAt)!,
    };
  }

  async list(actor: Actor): Promise<Project[]> {
    const rows = await this.deps.db.selectFrom('projects').selectAll().where('archivedAt', 'is', null).orderBy('name').execute();
    return Promise.all(rows.filter((r) => canAccessProject(actor, r.id)).map((r) => this.#view(r)));
  }

  async row(projectId: string): Promise<ProjectRow> {
    const row = await this.deps.db.selectFrom('projects').selectAll().where('id', '=', projectId).executeTakeFirst();
    if (!row || row.archivedAt) throw notFound(`Project "${projectId}"`);
    return row;
  }

  async get(actor: Actor, projectId: string): Promise<Project> {
    requireProjectAccess(actor, projectId);
    return this.#view(await this.row(projectId));
  }

  /** The project a GitHub repository belongs to (webhooks). */
  async byRepo(fullName: string): Promise<string | null> {
    const row = await this.deps.db.selectFrom('projectRepos').select('projectId').where('fullName', '=', fullName.toLowerCase()).executeTakeFirst();
    return row?.projectId ?? null;
  }

  async repos(projectId: string): Promise<{ fullName: string; defaultBranch: string | null }[]> {
    const rows = await this.deps.db.selectFrom('projectRepos').select(['displayName', 'defaultBranch']).where('projectId', '=', projectId).execute();
    return rows.map((r) => ({ fullName: r.displayName, defaultBranch: r.defaultBranch }));
  }

  async create(actor: Actor | null, input: ProjectInput): Promise<Project> {
    if (!/^[a-z0-9][a-z0-9-]{1,47}$/.test(input.id)) throw invalid('Project id must be 2-48 lowercase letters, digits or dashes');
    const now = this.deps.clock.now();
    const repos = (input.repos ?? []).map(parseRepo);
    await this.deps.db.transaction().execute(async (trx) => {
      const existing = await trx.selectFrom('projects').select('id').where('id', '=', input.id).executeTakeFirst();
      if (existing) throw conflict(`Project "${input.id}" already exists`);
      await trx
        .insertInto('projects')
        .values({
          id: input.id,
          name: input.name,
          kind: input.kind,
          packageIdent: input.packageIdent ?? null,
          defaultBranch: input.defaultBranch ?? 'main',
          summary: input.summary ?? '',
          conventions: input.conventions ?? '',
          milestone: input.milestone ?? '',
          importantDirs: toJson(input.importantDirs ?? []),
          structure: input.structure ?? '',
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
        })
        .execute();
      for (const repo of repos) await this.#addRepo(trx, input.id, repo);
    });
    const project = await this.get(actor ?? SYSTEM, input.id);
    if (actor) {
      const row = await this.activity.record({ projectId: input.id, actor, kind: 'project', summary: `created project ${input.name}`, importance: 1 });
      await this.activity.publish('project_updated', input.id, actor, project, row);
    }
    return project;
  }

  async #addRepo(trx: Tx, projectId: string, repo: { owner: string; name: string }) {
    const displayName = `${repo.owner}/${repo.name}`;
    const taken = await trx.selectFrom('projectRepos').select('projectId').where('fullName', '=', displayName.toLowerCase()).executeTakeFirst();
    if (taken && taken.projectId !== projectId) throw conflict(`Repository ${displayName} already belongs to project "${taken.projectId}"`);
    if (!taken) await trx.insertInto('projectRepos').values({ fullName: displayName.toLowerCase(), projectId, displayName, defaultBranch: null }).execute();
  }

  async update(actor: Actor, projectId: string, patch: ProjectPatch): Promise<Project> {
    requireProjectAccess(actor, projectId);
    await this.row(projectId);
    const changed: string[] = [];
    await this.deps.db.transaction().execute(async (trx) => {
      const values: Record<string, unknown> = { updatedAt: this.deps.clock.now() };
      for (const key of ['name', 'kind', 'packageIdent', 'defaultBranch', 'summary', 'conventions', 'milestone', 'structure'] as const) {
        if (patch[key] !== undefined) {
          values[key] = patch[key];
          changed.push(key);
        }
      }
      if (patch.importantDirs !== undefined) {
        values.importantDirs = toJson(patch.importantDirs);
        changed.push('importantDirs');
      }
      await trx.updateTable('projects').set(values).where('id', '=', projectId).execute();
      if (patch.repos !== undefined) {
        const repos = patch.repos.map(parseRepo);
        await trx.deleteFrom('projectRepos').where('projectId', '=', projectId).execute();
        for (const repo of repos) await this.#addRepo(trx, projectId, repo);
        changed.push('repos');
      }
    });
    const project = await this.get(actor, projectId);
    if (changed.length) {
      const summary = changed.includes('milestone') ? `set milestone: ${project.milestone}` : `updated project ${changed.join(', ')}`;
      const row = await this.activity.record({ projectId, actor, kind: 'project', summary, importance: changed.includes('milestone') ? 2 : 1 });
      await this.activity.publish('project_updated', projectId, actor, project, row);
    }
    return project;
  }

  async archive(projectId: string): Promise<void> {
    await this.deps.db.updateTable('projects').set({ archivedAt: this.deps.clock.now() }).where('id', '=', projectId).execute();
  }
}

/** Internal actor for server-side work (webhooks, sweeper, CLI). */
export const SYSTEM: Actor = {
  developerId: 'system',
  displayName: 'server',
  role: 'admin',
  keyId: null,
  scopes: ['admin'],
  projectIds: null,
  agentId: null,
};
