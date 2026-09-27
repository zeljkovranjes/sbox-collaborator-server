import type { TestRunRow } from '../db/schema.js';
import { forbidden, invalid, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { list, toJson } from '../lib/json.js';
import { truncate } from '../lib/relevance.js';
import { iso } from '../lib/time.js';
import type { ActivityService } from './activity.js';
import { requireProjectAccess, type Actor, type Deps } from './context.js';
import type { Directory } from './directory.js';
import type { ProjectService } from './projects.js';

export interface TestRun {
  id: string;
  projectId: string;
  developerId: string;
  developerName: string;
  agentId: string | null;
  commitSha: string | null;
  branch: string | null;
  build: string | null;
  scene: string | null;
  description: string;
  status: 'running' | 'passed' | 'failed' | 'error';
  errors: string[];
  logs: string[];
  screenshots: string[];
  startedAt: string;
  finishedAt: string | null;
}

export interface TestFields {
  commitSha?: string;
  branch?: string;
  build?: string;
  scene?: string;
}

export interface TestResultInput extends TestFields {
  testId?: string;
  project?: string;
  description?: string;
  status: 'passed' | 'failed' | 'error';
  errors?: string[];
  logs?: string[];
  screenshots?: string[];
}

export interface TestHooks {
  warnTeam(actor: Actor, projectId: string, body: string): Promise<void>;
}

export class TestService {
  hooks!: TestHooks;

  constructor(
    private readonly deps: Deps,
    private readonly directory: Directory,
    private readonly activity: ActivityService,
    private readonly projects: ProjectService,
  ) {}

  async view(rows: TestRunRow[]): Promise<TestRun[]> {
    return Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        projectId: row.projectId,
        developerId: row.developerId,
        developerName: (await this.directory.name(row.developerId)) ?? row.developerId,
        agentId: row.agentId,
        commitSha: row.commitSha,
        branch: row.branch,
        build: row.build,
        scene: row.scene,
        description: row.description,
        status: row.status as TestRun['status'],
        errors: list(row.errors),
        logs: list(row.logs),
        screenshots: list(row.screenshots),
        startedAt: iso(row.startedAt)!,
        finishedAt: iso(row.finishedAt),
      })),
    );
  }

  async start(actor: Actor, input: TestFields & { project: string; description: string }): Promise<TestRun> {
    requireProjectAccess(actor, input.project);
    await this.projects.row(input.project);
    if (!input.description.trim()) throw invalid('Describe what is being tested');
    const row = await this.deps.db
      .insertInto('testRuns')
      .values({
        id: `tr_${newId(10)}`,
        projectId: input.project,
        developerId: actor.developerId,
        agentId: actor.agentId,
        commitSha: input.commitSha ?? null,
        branch: input.branch ?? null,
        build: input.build ?? null,
        scene: input.scene ?? null,
        description: truncate(input.description, 400),
        status: 'running',
        errors: '[]',
        logs: '[]',
        screenshots: '[]',
        startedAt: this.deps.clock.now(),
        finishedAt: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const [run] = await this.view([row]);
    const activity = await this.activity.record({ projectId: row.projectId, actor, kind: 'test', summary: `started testing: ${row.description}${row.scene ? ` (${row.scene})` : ''}`, refType: 'test', refId: row.id, importance: 1 });
    await this.activity.publish('test_started', row.projectId, actor, run, activity);
    return run!;
  }

  async result(actor: Actor, input: TestResultInput): Promise<TestRun> {
    let run: TestRun;
    if (input.testId) {
      const existing = await this.deps.db.selectFrom('testRuns').selectAll().where('id', '=', input.testId).executeTakeFirst();
      if (!existing) throw notFound(`Test run ${input.testId}`);
      requireProjectAccess(actor, existing.projectId);
      if (existing.developerId !== actor.developerId) throw forbidden('That test run belongs to another developer');
      run = (await this.view([existing]))[0]!;
    } else {
      if (!input.project || !input.description) throw invalid('Pass testId, or project and description');
      run = await this.start(actor, { project: input.project, description: input.description, ...pick(input) });
    }
    const values: Record<string, unknown> = {
      status: input.status,
      finishedAt: this.deps.clock.now(),
      errors: toJson((input.errors ?? []).map((e) => truncate(e, 1000)).slice(0, 30)),
      logs: toJson((input.logs ?? []).slice(0, 20)),
      screenshots: toJson((input.screenshots ?? []).slice(0, 20)),
    };
    for (const [key, value] of Object.entries(pick(input))) values[key] = value;
    const row = await this.deps.db.updateTable('testRuns').set(values).where('id', '=', run.id).returningAll().executeTakeFirstOrThrow();
    const [finished] = await this.view([row]);
    const failed = row.status !== 'passed';
    const where = [row.scene, row.commitSha ? row.commitSha.slice(0, 7) : null, row.branch].filter(Boolean).join(' · ');
    const firstError = finished!.errors[0];
    const activity = await this.activity.record({
      projectId: row.projectId,
      actor,
      kind: failed ? 'build_failed' : 'test',
      summary: `${failed ? (row.status === 'error' ? 'build/test error' : 'test FAILED') : 'test passed'}: ${row.description}${where ? ` (${where})` : ''}${failed && firstError ? ` – ${truncate(firstError, 120)}` : ''}`,
      refType: 'test',
      refId: row.id,
      importance: failed ? 3 : 1,
    });
    await this.activity.publish('test_result', row.projectId, actor, finished, activity);
    if (failed && row.commitSha) {
      await this.activity.publish('build_broken', row.projectId, actor, finished);
      await this.hooks.warnTeam(actor, row.projectId, `Commit ${row.commitSha.slice(0, 7)}${row.branch ? ` on ${row.branch}` : ''} is broken: ${row.description}${firstError ? ` – ${truncate(firstError, 300)}` : ''}`);
    }
    return finished!;
  }

  async recent(actor: Actor, projectId: string, filter: { branch?: string; commitSha?: string; limit?: number } = {}): Promise<TestRun[]> {
    requireProjectAccess(actor, projectId);
    let query = this.deps.db.selectFrom('testRuns').selectAll().where('projectId', '=', projectId);
    if (filter.branch) query = query.where('branch', '=', filter.branch);
    if (filter.commitSha) query = query.where('commitSha', 'like', `${filter.commitSha}%`);
    return this.view(await query.orderBy('startedAt', 'desc').limit(Math.min(filter.limit ?? 20, 100)).execute());
  }

  /** Latest finished run per branch (build status overview). */
  async latestPerBranch(projectId: string): Promise<TestRun[]> {
    const rows = await this.deps.db
      .selectFrom('testRuns')
      .selectAll()
      .where('projectId', '=', projectId)
      .where('status', '!=', 'running')
      .where('startedAt', '>', this.deps.clock.now() - 14 * 86_400_000)
      .orderBy('startedAt', 'desc')
      .limit(200)
      .execute();
    const seen = new Set<string>();
    const latest = rows.filter((r) => {
      const key = r.branch ?? '(none)';
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return this.view(latest);
  }
}

function pick(input: TestFields): TestFields {
  const out: TestFields = {};
  if (input.commitSha !== undefined) out.commitSha = input.commitSha;
  if (input.branch !== undefined) out.branch = input.branch;
  if (input.build !== undefined) out.build = input.build;
  if (input.scene !== undefined) out.scene = input.scene;
  return out;
}
