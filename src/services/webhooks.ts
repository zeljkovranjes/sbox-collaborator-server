import type { CommitRow } from '../db/schema.js';
import { hmac, safeEqual } from '../lib/ids.js';
import { toJson } from '../lib/json.js';
import { log } from '../lib/log.js';
import { truncate } from '../lib/relevance.js';
import { createHmac } from 'node:crypto';
import type { ActivityService } from './activity.js';
import type { AgentService } from './agents.js';
import type { AssetService } from './assets.js';
import type { Deps } from './context.js';
import type { Directory } from './directory.js';
import type { GitService } from './git.js';
import type { GhIssue, GhPull } from './github.js';
import type { MessageService } from './messages.js';
import { SYSTEM, type ProjectService } from './projects.js';
import type { ReservationService } from './reservations.js';
import type { TaskService } from './tasks.js';

void hmac;

/** Verifies GitHub's X-Hub-Signature-256 header over the raw request body. */
export function verifyGithubSignature(secret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  return safeEqual(expected, header);
}

interface PushPayload {
  ref: string;
  before: string;
  after: string;
  created: boolean;
  deleted: boolean;
  forced: boolean;
  compare?: string;
  repository: { full_name: string; default_branch: string };
  pusher?: { name: string };
  sender?: { login: string };
  commits: {
    id: string;
    message: string;
    timestamp: string;
    url: string;
    author: { name: string; username?: string };
    added: string[];
    modified: string[];
    removed: string[];
  }[];
  head_commit?: { id: string } | null;
}

export type WebhookResult = { status: 'processed' | 'duplicate' | 'ignored'; detail?: string };

export class WebhookService {
  constructor(
    private readonly deps: Deps,
    private readonly directory: Directory,
    private readonly activity: ActivityService,
    private readonly projects: ProjectService,
    private readonly agents: AgentService,
    private readonly tasks: TaskService,
    private readonly reservations: ReservationService,
    private readonly assets: AssetService,
    private readonly git: GitService,
    private readonly messages: MessageService,
  ) {}

  async handle(event: string, deliveryId: string, payload: any): Promise<WebhookResult> {
    if (deliveryId) {
      const seen = await this.deps.db.selectFrom('webhookDeliveries').select('id').where('id', '=', deliveryId).executeTakeFirst();
      if (seen) return { status: 'duplicate' };
    }
    let result: WebhookResult;
    try {
      result = await this.#dispatch(event, payload);
    } catch (error) {
      log.error('webhook processing failed', { event, deliveryId, error: (error as Error).message });
      throw error;
    }
    if (deliveryId) {
      await this.deps.db
        .insertInto('webhookDeliveries')
        .values({ id: deliveryId, event, receivedAt: this.deps.clock.now(), status: result.status })
        .execute()
        .catch(() => undefined);
    }
    return result;
  }

  async #dispatch(event: string, payload: any): Promise<WebhookResult> {
    if (event === 'ping') return { status: 'processed', detail: 'pong' };
    const repo: string | undefined = payload?.repository?.full_name;
    if (!repo) return { status: 'ignored', detail: 'no repository' };
    const projectId = await this.projects.byRepo(repo);
    if (!projectId) return { status: 'ignored', detail: `repository ${repo} is not linked to a project` };
    switch (event) {
      case 'push':
        return this.#push(projectId, payload as PushPayload);
      case 'create':
      case 'delete':
        return this.#branchRef(projectId, event, payload);
      case 'pull_request':
        return this.#pullRequest(projectId, payload);
      case 'pull_request_review':
        return this.#review(projectId, payload);
      case 'issues':
        return this.#issue(projectId, payload);
      default:
        return { status: 'ignored', detail: `event ${event} not handled` };
    }
  }

  async #push(projectId: string, push: PushPayload): Promise<WebhookResult> {
    if (!push.ref?.startsWith('refs/heads/')) return { status: 'ignored', detail: 'not a branch push' };
    const branch = push.ref.slice('refs/heads/'.length);
    const repo = push.repository.full_name;
    const now = this.deps.clock.now();
    const pusherLogin = push.sender?.login ?? push.pusher?.name ?? null;
    const pusher = await this.directory.byGithubLogin(pusherLogin);
    const who = { developerId: pusher?.id ?? null, agentId: null } as { developerId: string; agentId: string | null };

    // Branch bookkeeping.
    const existing = await this.deps.db.selectFrom('branches').select('name').where('projectId', '=', projectId).where('repo', '=', repo).where('name', '=', branch).executeTakeFirst();
    if (push.deleted) {
      if (existing) await this.deps.db.updateTable('branches').set({ deletedAt: now }).where('projectId', '=', projectId).where('repo', '=', repo).where('name', '=', branch).execute();
      const activity = await this.activity.record({ projectId, actor: who, kind: 'branch', summary: `${pusher?.displayName ?? pusherLogin ?? 'someone'} deleted branch ${branch}`, refType: 'branch', refId: branch, importance: 0 });
      await this.activity.publish('branch_updated', projectId, who, { repo, branch, deleted: true }, activity);
      return { status: 'processed', detail: 'branch deleted' };
    }
    const branchValues = { headSha: push.after, lastPushAt: now, lastPusherLogin: pusherLogin, developerId: pusher?.id ?? null, deletedAt: null };
    if (existing) await this.deps.db.updateTable('branches').set(branchValues).where('projectId', '=', projectId).where('repo', '=', repo).where('name', '=', branch).execute();
    else await this.deps.db.insertInto('branches').values({ projectId, repo, name: branch, ...branchValues }).execute();

    // Correlate commits with developers, tasks and agents.
    const branchTasks = await this.tasks.byBranch(projectId, branch);
    const liveAgents = await this.deps.db
      .selectFrom('agents')
      .select(['id', 'developerId', 'branch', 'currentTaskId'])
      .where('projectId', '=', projectId)
      .where('endedAt', 'is', null)
      .where('lastHeartbeatAt', '>', now - this.deps.config.agentOfflineAfterMs - this.deps.config.reservationGraceMs)
      .execute();
    const rows: CommitRow[] = [];
    for (const commit of push.commits.slice(0, 200)) {
      const developer = (await this.directory.byGithubLogin(commit.author.username)) ?? pusher;
      const referenced = await this.tasks.findReferenced(projectId, [commit.message]);
      const task = referenced[0] ?? branchTasks.find((t) => !developer || t.ownerId === developer.id) ?? branchTasks[0];
      const agent =
        liveAgents.find((a) => a.developerId === developer?.id && task && a.currentTaskId === task.id) ??
        liveAgents.find((a) => a.developerId === developer?.id && a.branch === branch);
      rows.push({
        projectId,
        sha: commit.id,
        repo,
        branch,
        message: truncate(commit.message, 4000),
        authorName: commit.author.name,
        authorLogin: commit.author.username ?? null,
        developerId: developer?.id ?? null,
        url: commit.url,
        at: Date.parse(commit.timestamp) || now,
        pushedAt: now,
        added: toJson(commit.added),
        modified: toJson(commit.modified),
        removed: toJson(commit.removed),
        taskId: task?.id ?? null,
        agentId: agent?.id ?? null,
      });
    }
    const inserted = await this.git.storeCommits(rows);
    const commits = inserted.length ? inserted : rows;
    if (!commits.length) return { status: 'processed', detail: 'no commits' };

    // Assets touched by the push.
    const touched = new Set<string>();
    for (const row of inserted) {
      const files = await this.assets.recordCommit(projectId, {
        sha: row.sha,
        developerId: row.developerId,
        added: JSON.parse(row.added),
        modified: JSON.parse(row.modified),
        removed: JSON.parse(row.removed),
      });
      files.forEach((f) => touched.add(f));
    }

    // Feed entry for the push.
    const name = pusher?.displayName ?? pusherLogin ?? 'someone';
    const head = commits[commits.length - 1]!;
    const taskIds = [...new Set(commits.map((c) => c.taskId).filter((id): id is number => id != null))];
    const isDefault = branch === push.repository.default_branch;
    const summary =
      commits.length === 1
        ? `${name} committed ${head.sha.slice(0, 7)} to ${branch}: ${truncate(head.message.split('\n')[0], 100)}`
        : `${name} pushed ${commits.length} commits to ${branch} (${head.sha.slice(0, 7)}: ${truncate(head.message.split('\n')[0], 80)})`;
    const activity = await this.activity.record({
      projectId,
      actor: { developerId: pusher?.id ?? (null as unknown as string), agentId: head.agentId },
      kind: 'commit',
      summary: `${summary}${push.forced ? ' [force-push]' : ''}${taskIds.length ? ` · ${taskIds.map((id) => `#${id}`).join(' ')}` : ''}`,
      refType: 'commit',
      refId: head.sha,
      importance: push.forced || isDefault ? 2 : 1,
      data: { branch, repo, count: commits.length, compare: push.compare },
    });
    await this.activity.publish('commit_detected', projectId, who, { repo, branch, forced: push.forced, commits: commits.map((c) => ({ sha: c.sha, message: c.message, developerId: c.developerId, taskId: c.taskId })) }, activity);
    if (touched.size) await this.activity.publish('asset_changed', projectId, who, { commit: head.sha, paths: [...touched].slice(0, 100) });

    // Someone pushed changes to files another developer has reserved: warn the reservation owner.
    const files = [...new Set(commits.flatMap((c) => [...JSON.parse(c.added), ...JSON.parse(c.modified), ...JSON.parse(c.removed)] as string[]))];
    const conflicts = await this.reservations.overlapping(projectId, files, pusher?.id ?? null);
    const byOwner = new Map<string, string[]>();
    for (const c of conflicts) byOwner.set(c.reservation.developerId, [...(byOwner.get(c.reservation.developerId) ?? []), c.path]);
    for (const [ownerId, paths] of byOwner) {
      const unique = [...new Set(paths)];
      const warning = await this.activity.record({
        projectId,
        actor: { developerId: pusher?.id ?? (null as unknown as string), agentId: null },
        kind: 'conflict',
        summary: `${name} pushed changes to ${unique.slice(0, 3).join(', ')}${unique.length > 3 ? ` +${unique.length - 3}` : ''} reserved by ${await this.directory.name(ownerId)}`,
        refType: 'commit',
        refId: head.sha,
        importance: 3,
      });
      await this.activity.publish('activity', projectId, who, null, warning);
      await this.messages
        .send(
          { ...SYSTEM, developerId: pusher?.id ?? 'system', displayName: name, projectIds: null },
          {
            project: projectId,
            to: ownerId,
            type: 'warning',
            body: `${name} pushed ${head.sha.slice(0, 7)} to ${branch} touching files you reserved: ${unique.slice(0, 10).join(', ')}. Pull before continuing.`,
            paths: unique.slice(0, 20),
          },
        )
        .catch((error) => log.warn('reservation warning not sent', { error: (error as Error).message }));
    }
    return { status: 'processed', detail: `${inserted.length} new commit(s)` };
  }

  async #branchRef(projectId: string, event: 'create' | 'delete', payload: any): Promise<WebhookResult> {
    if (payload.ref_type !== 'branch') return { status: 'ignored', detail: 'not a branch' };
    const repo = payload.repository.full_name as string;
    const branch = payload.ref as string;
    const sender = await this.directory.byGithubLogin(payload.sender?.login);
    const now = this.deps.clock.now();
    const existing = await this.deps.db.selectFrom('branches').select('name').where('projectId', '=', projectId).where('repo', '=', repo).where('name', '=', branch).executeTakeFirst();
    if (event === 'create') {
      const values = { headSha: null, lastPushAt: now, lastPusherLogin: payload.sender?.login ?? null, developerId: sender?.id ?? null, deletedAt: null };
      if (existing) await this.deps.db.updateTable('branches').set(values).where('projectId', '=', projectId).where('repo', '=', repo).where('name', '=', branch).execute();
      else await this.deps.db.insertInto('branches').values({ projectId, repo, name: branch, ...values }).execute();
    } else if (existing) {
      await this.deps.db.updateTable('branches').set({ deletedAt: now }).where('projectId', '=', projectId).where('repo', '=', repo).where('name', '=', branch).execute();
    }
    const who = { developerId: sender?.id ?? (null as unknown as string), agentId: null };
    const activity = await this.activity.record({ projectId, actor: who, kind: 'branch', summary: `${sender?.displayName ?? payload.sender?.login ?? 'someone'} ${event === 'create' ? 'created' : 'deleted'} branch ${branch}`, refType: 'branch', refId: branch, importance: 0 });
    await this.activity.publish('branch_updated', projectId, who, { repo, branch, deleted: event === 'delete' }, activity);
    return { status: 'processed' };
  }

  async #pullRequest(projectId: string, payload: any): Promise<WebhookResult> {
    const pull = payload.pull_request as GhPull;
    const repo = payload.repository.full_name as string;
    const action = payload.action as string;
    const referenced = await this.tasks.findReferenced(projectId, [pull.title, pull.head.ref, String(payload.pull_request?.body ?? '')]);
    const branchTasks = await this.tasks.byBranch(projectId, pull.head.ref);
    const task = referenced[0] ?? branchTasks[0] ?? null;
    await this.git.upsertPull(projectId, repo, pull, task?.id ?? null);
    const sender = await this.directory.byGithubLogin(payload.sender?.login);
    const who = { developerId: sender?.id ?? (null as unknown as string), agentId: null };
    const name = sender?.displayName ?? payload.sender?.login ?? 'someone';
    const merged = action === 'closed' && !!pull.merged_at;
    if (task && !task.githubPr) {
      await this.deps.db.updateTable('tasks').set({ githubPr: pull.number, updatedAt: this.deps.clock.now() }).where('id', '=', task.id).execute();
    }
    // A merged PR finishes a linked task that was waiting in review.
    if (merged && task && task.status === 'review') {
      await this.deps.db
        .updateTable('tasks')
        .set({ status: 'done', completedAt: this.deps.clock.now(), updatedAt: this.deps.clock.now(), version: task.version + 1, completionSummary: task.completionSummary ?? `Merged in PR #${pull.number}` })
        .where('id', '=', task.id)
        .where('version', '=', task.version)
        .execute();
    }
    const interesting = ['opened', 'closed', 'reopened', 'ready_for_review'].includes(action);
    const verb = merged ? 'merged' : action === 'closed' ? 'closed' : action.replace(/_/g, ' ');
    const activity = interesting
      ? await this.activity.record({
          projectId,
          actor: who,
          kind: 'pull_request',
          summary: `${name} ${verb} PR #${pull.number} "${truncate(pull.title, 100)}" (${pull.head.ref} → ${pull.base.ref})${task ? ` · #${task.id}` : ''}`,
          refType: 'pull_request',
          refId: pull.number,
          importance: merged ? 2 : 1,
        })
      : undefined;
    await this.activity.publish('pull_request_updated', projectId, who, { repo, number: pull.number, title: pull.title, action, merged, taskId: task?.id ?? null, url: pull.html_url }, activity);
    return { status: 'processed' };
  }

  async #review(projectId: string, payload: any): Promise<WebhookResult> {
    if (payload.action !== 'submitted') return { status: 'ignored', detail: 'review not submitted' };
    const state = String(payload.review?.state ?? '').toLowerCase();
    const reviewer = await this.directory.byGithubLogin(payload.review?.user?.login);
    const who = { developerId: reviewer?.id ?? (null as unknown as string), agentId: null };
    const verb = state === 'approved' ? 'approved' : state === 'changes_requested' ? 'requested changes on' : 'reviewed';
    const activity = await this.activity.record({
      projectId,
      actor: who,
      kind: 'pull_request',
      summary: `${reviewer?.displayName ?? payload.review?.user?.login ?? 'someone'} ${verb} PR #${payload.pull_request.number} "${truncate(payload.pull_request.title, 100)}"`,
      refType: 'pull_request',
      refId: payload.pull_request.number,
      importance: state === 'changes_requested' ? 2 : 1,
    });
    await this.activity.publish('pull_request_updated', projectId, who, { number: payload.pull_request.number, review: state }, activity);
    return { status: 'processed' };
  }

  async #issue(projectId: string, payload: any): Promise<WebhookResult> {
    const issue = payload.issue as GhIssue;
    const repo = payload.repository.full_name as string;
    await this.git.upsertIssue(projectId, repo, issue);
    const action = payload.action as string;
    if (!['opened', 'closed', 'reopened'].includes(action)) return { status: 'processed' };
    const sender = await this.directory.byGithubLogin(payload.sender?.login);
    const who = { developerId: sender?.id ?? (null as unknown as string), agentId: null };
    const activity = await this.activity.record({
      projectId,
      actor: who,
      kind: 'issue',
      summary: `${sender?.displayName ?? payload.sender?.login ?? 'someone'} ${action} issue #${issue.number} "${truncate(issue.title, 100)}"`,
      refType: 'issue',
      refId: issue.number,
      importance: 1,
    });
    await this.activity.publish('issue_updated', projectId, who, { repo, number: issue.number, title: issue.title, state: issue.state, action, url: issue.html_url }, activity);
    return { status: 'processed' };
  }
}
