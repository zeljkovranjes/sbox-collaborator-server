import type { CommitRow } from '../db/schema.js';
import { AppError, invalid, notFound } from '../lib/errors.js';
import { list, toJson } from '../lib/json.js';
import { log } from '../lib/log.js';
import { truncate } from '../lib/relevance.js';
import { iso } from '../lib/time.js';
import type { ActivityService } from './activity.js';
import type { AgentService } from './agents.js';
import { requireProjectAccess, type Actor, type Deps } from './context.js';
import type { Directory } from './directory.js';
import type { GhIssue, GhPull, GitHubClient } from './github.js';
import type { ProjectService } from './projects.js';
import type { TaskService } from './tasks.js';
import type { TestService } from './tests.js';

export interface Commit {
  sha: string;
  shortSha: string;
  projectId: string;
  repo: string;
  branch: string | null;
  message: string;
  authorName: string | null;
  authorLogin: string | null;
  developerId: string | null;
  url: string | null;
  at: string;
  added: string[];
  modified: string[];
  removed: string[];
  taskId: number | null;
}

export interface IssueView {
  repo: string;
  number: number;
  title: string;
  state: string;
  author: string | null;
  url: string | null;
  labels: string[];
  updatedAt: string;
  taskId: number | null;
}

export interface PullView {
  repo: string;
  number: number;
  title: string;
  state: string;
  merged: boolean;
  author: string | null;
  head: string | null;
  base: string | null;
  url: string | null;
  updatedAt: string;
  taskId: number | null;
}

export const commitView = (row: CommitRow): Commit => ({
  sha: row.sha,
  shortSha: row.sha.slice(0, 7),
  projectId: row.projectId,
  repo: row.repo,
  branch: row.branch,
  message: row.message,
  authorName: row.authorName,
  authorLogin: row.authorLogin,
  developerId: row.developerId,
  url: row.url,
  at: iso(row.at)!,
  added: list(row.added),
  modified: list(row.modified),
  removed: list(row.removed),
  taskId: row.taskId,
});

export class GitService {
  constructor(
    private readonly deps: Deps,
    private readonly directory: Directory,
    private readonly activity: ActivityService,
    private readonly projects: ProjectService,
    private readonly agents: AgentService,
    private readonly tasks: TaskService,
    private readonly tests: TestService,
    readonly github: GitHubClient,
  ) {}

  async #repo(projectId: string, repo?: string): Promise<string> {
    const repos = await this.projects.repos(projectId);
    if (!repos.length) throw invalid(`Project "${projectId}" has no GitHub repository configured (project_update_context repos)`);
    if (!repo) return repos[0]!.fullName;
    const match = repos.find((r) => r.fullName.toLowerCase() === repo.toLowerCase());
    if (!match) throw invalid(`Repository ${repo} is not part of project "${projectId}"`);
    return match.fullName;
  }

  /** Stores commits (from webhooks or API backfill). Returns the newly inserted rows. */
  async storeCommits(rows: CommitRow[]): Promise<CommitRow[]> {
    const inserted: CommitRow[] = [];
    for (const row of rows) {
      const existing = await this.deps.db.selectFrom('commits').select('sha').where('projectId', '=', row.projectId).where('sha', '=', row.sha).executeTakeFirst();
      if (existing) continue;
      await this.deps.db.insertInto('commits').values(row).execute();
      inserted.push(row);
    }
    return inserted;
  }

  /** When no webhook has delivered commits yet, pull the latest ones from the GitHub API once. */
  async #backfill(projectId: string, branch?: string): Promise<void> {
    const recent = await this.deps.db.selectFrom('commits').select('sha').where('projectId', '=', projectId).where('pushedAt', '>', this.deps.clock.now() - 30 * 86_400_000).limit(1).execute();
    if (recent.length) return;
    const project = await this.projects.row(projectId);
    for (const repo of await this.projects.repos(projectId)) {
      try {
        const commits = await this.github.listCommits(repo.fullName, { branch: branch ?? repo.defaultBranch ?? project.defaultBranch, perPage: 30 });
        const rows: CommitRow[] = [];
        for (const c of commits) {
          const developer = await this.directory.byGithubLogin(c.author?.login);
          const at = c.commit.author?.date ? Date.parse(c.commit.author.date) : this.deps.clock.now();
          rows.push({
            projectId,
            sha: c.sha,
            repo: repo.fullName,
            branch: branch ?? repo.defaultBranch ?? project.defaultBranch,
            message: truncate(c.commit.message, 2000),
            authorName: c.commit.author?.name ?? null,
            authorLogin: c.author?.login ?? null,
            developerId: developer?.id ?? null,
            url: c.html_url,
            at,
            pushedAt: at,
            added: '[]',
            modified: '[]',
            removed: '[]',
            taskId: null,
            agentId: null,
          });
        }
        await this.storeCommits(rows);
      } catch (error) {
        log.debug('commit backfill skipped', { repo: repo.fullName, error: (error as Error).message });
      }
    }
  }

  async recentCommits(actor: Actor, projectId: string, filter: { branch?: string; limit?: number; since?: number; author?: string } = {}): Promise<Commit[]> {
    requireProjectAccess(actor, projectId);
    await this.#backfill(projectId, filter.branch);
    let query = this.deps.db.selectFrom('commits').selectAll().where('projectId', '=', projectId);
    if (filter.branch) query = query.where('branch', '=', filter.branch);
    if (filter.since) query = query.where('at', '>=', filter.since);
    if (filter.author) {
      const developer = (await this.directory.get(filter.author)) ?? (await this.directory.byGithubLogin(filter.author));
      query = developer ? query.where('developerId', '=', developer.id) : query.where('authorLogin', '=', filter.author);
    }
    const rows = await query.orderBy('at', 'desc').limit(Math.min(filter.limit ?? 20, 100)).execute();
    return rows.map(commitView);
  }

  async getCommit(actor: Actor, projectId: string, sha: string) {
    requireProjectAccess(actor, projectId);
    if (!/^[0-9a-f]{4,40}$/i.test(sha)) throw invalid('sha must be a hex commit id');
    const stored = await this.deps.db.selectFrom('commits').selectAll().where('projectId', '=', projectId).where('sha', 'like', `${sha.toLowerCase()}%`).executeTakeFirst();
    const repo = stored?.repo ?? (await this.#repo(projectId));
    try {
      const detail = await this.github.getCommit(repo, stored?.sha ?? sha);
      return {
        sha: detail.sha,
        repo,
        message: detail.commit.message,
        author: detail.author?.login ?? detail.commit.author?.name ?? null,
        at: detail.commit.author?.date ?? null,
        url: detail.html_url,
        branch: stored?.branch ?? null,
        taskId: stored?.taskId ?? null,
        stats: detail.stats ?? null,
        files: (detail.files ?? []).map((f) => ({ path: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, previousPath: f.previous_filename })),
      };
    } catch (error) {
      if (!stored) throw error instanceof AppError && error.code === 'not_found' ? notFound(`Commit ${sha}`) : error;
      return { ...commitView(stored), note: `GitHub details unavailable: ${(error as Error).message}` };
    }
  }

  async changedFiles(actor: Actor, projectId: string, base: string, head: string, repo?: string) {
    requireProjectAccess(actor, projectId);
    const fullName = await this.#repo(projectId, repo);
    const compare = await this.github.compare(fullName, base, head);
    return {
      repo: fullName,
      base,
      head,
      status: compare.status,
      aheadBy: compare.ahead_by,
      behindBy: compare.behind_by,
      commits: compare.commits.slice(-30).map((c) => ({ sha: c.sha.slice(0, 7), message: truncate(c.commit.message.split('\n')[0], 120), author: c.author?.login ?? c.commit.author?.name ?? null })),
      files: (compare.files ?? []).map((f) => ({ path: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, previousPath: f.previous_filename })),
    };
  }

  async branchActivity(actor: Actor, projectId: string, limit = 20) {
    requireProjectAccess(actor, projectId);
    const branches = await this.deps.db
      .selectFrom('branches')
      .selectAll()
      .where('projectId', '=', projectId)
      .where('deletedAt', 'is', null)
      .orderBy('lastPushAt', 'desc')
      .limit(Math.min(limit, 100))
      .execute();
    const agents = await this.agents.listActive(actor, projectId);
    return Promise.all(
      branches.map(async (b) => {
        const tasks = await this.tasks.byBranch(projectId, b.name);
        return {
          repo: b.repo,
          name: b.name,
          headSha: b.headSha?.slice(0, 7) ?? null,
          lastPushAt: iso(b.lastPushAt),
          lastPusher: (await this.directory.name(b.developerId)) ?? b.lastPusherLogin,
          agents: agents.filter((a) => a.branch === b.name).map((a) => `${a.label} (${a.status})`),
          tasks: tasks.map((t) => `#${t.id} ${t.title} [${t.status}]`),
        };
      }),
    );
  }

  async status(actor: Actor, projectId: string) {
    requireProjectAccess(actor, projectId);
    const project = await this.projects.row(projectId);
    const [branches, pulls, latestTests, headCommit] = await Promise.all([
      this.branchActivity(actor, projectId, 10),
      this.deps.db.selectFrom('pullRequests').selectAll().where('projectId', '=', projectId).where('state', '=', 'open').orderBy('updatedAt', 'desc').limit(15).execute(),
      this.tests.latestPerBranch(projectId),
      this.deps.db.selectFrom('commits').selectAll().where('projectId', '=', projectId).where('branch', '=', project.defaultBranch).orderBy('at', 'desc').executeTakeFirst(),
    ]);
    return {
      repos: (await this.projects.repos(projectId)).map((r) => r.fullName),
      defaultBranch: project.defaultBranch,
      head: headCommit ? { sha: headCommit.sha.slice(0, 7), message: truncate(headCommit.message.split('\n')[0], 120), author: (await this.directory.name(headCommit.developerId)) ?? headCommit.authorName, at: iso(headCommit.at) } : null,
      activeBranches: branches,
      openPullRequests: pulls.map((p) => ({ number: p.number, title: p.title, author: p.authorLogin, head: p.headRef, base: p.baseRef, url: p.url, taskId: p.taskId })),
      buildStatus: latestTests.map((t) => ({ branch: t.branch, status: t.status, commit: t.commitSha?.slice(0, 7) ?? null, description: t.description, by: t.developerName, at: t.finishedAt })),
      webhooksConfigured: !!this.deps.config.github.webhookSecret,
    };
  }

  // ---- issues & pull requests -------------------------------------------------------------

  async upsertIssue(projectId: string, repo: string, issue: GhIssue): Promise<void> {
    const values = {
      title: truncate(issue.title, 300),
      state: issue.state,
      authorLogin: issue.user?.login ?? null,
      url: issue.html_url,
      labels: toJson(issue.labels.map((l) => (typeof l === 'string' ? l : l.name))),
      updatedAt: Date.parse(issue.updated_at) || this.deps.clock.now(),
    };
    const existing = await this.deps.db.selectFrom('issues').select('number').where('projectId', '=', projectId).where('repo', '=', repo).where('number', '=', issue.number).executeTakeFirst();
    if (existing) await this.deps.db.updateTable('issues').set(values).where('projectId', '=', projectId).where('repo', '=', repo).where('number', '=', issue.number).execute();
    else await this.deps.db.insertInto('issues').values({ projectId, repo, number: issue.number, taskId: null, ...values }).execute();
  }

  async upsertPull(projectId: string, repo: string, pull: GhPull, taskId: number | null = null): Promise<void> {
    const values = {
      title: truncate(pull.title, 300),
      state: pull.state,
      authorLogin: pull.user?.login ?? null,
      headRef: pull.head.ref,
      baseRef: pull.base.ref,
      merged: pull.merged_at ? 1 : 0,
      url: pull.html_url,
      updatedAt: Date.parse(pull.updated_at) || this.deps.clock.now(),
    };
    const existing = await this.deps.db.selectFrom('pullRequests').select(['number', 'taskId']).where('projectId', '=', projectId).where('repo', '=', repo).where('number', '=', pull.number).executeTakeFirst();
    if (existing) {
      await this.deps.db
        .updateTable('pullRequests')
        .set({ ...values, taskId: existing.taskId ?? taskId })
        .where('projectId', '=', projectId)
        .where('repo', '=', repo)
        .where('number', '=', pull.number)
        .execute();
    } else await this.deps.db.insertInto('pullRequests').values({ projectId, repo, number: pull.number, taskId, ...values }).execute();
  }

  async issues(actor: Actor, projectId: string, state: 'open' | 'closed' | 'all' = 'open', limit = 30): Promise<IssueView[]> {
    requireProjectAccess(actor, projectId);
    for (const repo of await this.projects.repos(projectId)) {
      try {
        for (const issue of await this.github.listIssues(repo.fullName, state, Math.min(limit, 100))) {
          if (!issue.pull_request) await this.upsertIssue(projectId, repo.fullName, issue);
        }
      } catch (error) {
        log.debug('issue refresh skipped', { repo: repo.fullName, error: (error as Error).message });
      }
    }
    let query = this.deps.db.selectFrom('issues').selectAll().where('projectId', '=', projectId);
    if (state !== 'all') query = query.where('state', '=', state);
    const rows = await query.orderBy('updatedAt', 'desc').limit(Math.min(limit, 100)).execute();
    return rows.map((r) => ({ repo: r.repo, number: r.number, title: r.title, state: r.state, author: r.authorLogin, url: r.url, labels: list(r.labels), updatedAt: iso(r.updatedAt)!, taskId: r.taskId }));
  }

  async pulls(actor: Actor, projectId: string, state: 'open' | 'closed' | 'all' = 'open', limit = 30): Promise<PullView[]> {
    requireProjectAccess(actor, projectId);
    for (const repo of await this.projects.repos(projectId)) {
      try {
        for (const pull of await this.github.listPulls(repo.fullName, state, Math.min(limit, 100))) await this.upsertPull(projectId, repo.fullName, pull);
      } catch (error) {
        log.debug('pull refresh skipped', { repo: repo.fullName, error: (error as Error).message });
      }
    }
    let query = this.deps.db.selectFrom('pullRequests').selectAll().where('projectId', '=', projectId);
    if (state !== 'all') query = query.where('state', '=', state);
    const rows = await query.orderBy('updatedAt', 'desc').limit(Math.min(limit, 100)).execute();
    return rows.map((r) => ({ repo: r.repo, number: r.number, title: r.title, state: r.state, merged: r.merged === 1, author: r.authorLogin, head: r.headRef, base: r.baseRef, url: r.url, updatedAt: iso(r.updatedAt)!, taskId: r.taskId }));
  }

  async createIssue(actor: Actor, projectId: string, input: { title: string; body?: string; labels?: string[]; taskId?: number; repo?: string }) {
    requireProjectAccess(actor, projectId);
    const repo = await this.#repo(projectId, input.repo);
    const body = `${input.body ?? ''}\n\n_Filed by ${actor.displayName} via the s&box collaboration server._`.trim();
    const issue = await this.github.createIssue(repo, { title: input.title, body, ...(input.labels ? { labels: input.labels } : {}) });
    await this.upsertIssue(projectId, repo, issue);
    if (input.taskId) await this.linkTask(actor, input.taskId, { issue: issue.number });
    const activity = await this.activity.record({ projectId, actor, kind: 'issue', summary: `opened issue #${issue.number} "${truncate(issue.title, 120)}"`, refType: 'issue', refId: issue.number, importance: 1 });
    await this.activity.publish('issue_updated', projectId, actor, { repo, number: issue.number, title: issue.title, state: issue.state, url: issue.html_url }, activity);
    return { repo, number: issue.number, url: issue.html_url, title: issue.title };
  }

  async linkTask(actor: Actor, taskId: number, link: { issue?: number; pullRequest?: number }) {
    if (link.issue === undefined && link.pullRequest === undefined) throw invalid('Pass issue and/or pullRequest');
    const task = await this.tasks.get(actor, taskId);
    const patch: { githubIssue?: number; githubPr?: number } = {};
    if (link.issue !== undefined) {
      patch.githubIssue = link.issue;
      await this.deps.db.updateTable('issues').set({ taskId }).where('projectId', '=', task.projectId).where('number', '=', link.issue).execute();
    }
    if (link.pullRequest !== undefined) {
      patch.githubPr = link.pullRequest;
      await this.deps.db.updateTable('pullRequests').set({ taskId }).where('projectId', '=', task.projectId).where('number', '=', link.pullRequest).execute();
    }
    return this.tasks.update(actor, taskId, patch);
  }

  async recentActivity(actor: Actor, projectId: string, limit = 30) {
    requireProjectAccess(actor, projectId);
    const rows = await this.deps.db
      .selectFrom('activity')
      .selectAll()
      .where('projectId', '=', projectId)
      .where('refType', 'in', ['commit', 'push', 'pull_request', 'issue', 'branch'])
      .orderBy('at', 'desc')
      .limit(Math.min(limit, 100))
      .execute();
    return this.activity.view(rows);
  }
}
