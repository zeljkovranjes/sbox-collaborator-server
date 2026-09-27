import * as z from 'zod';
import { parseSince } from '../lib/time.js';
import { defineTool, limitArg, projectOf, sinceArg, taskIdArg } from './registry.js';

const project = z.string().max(48).optional();
const state = z.enum(['open', 'closed', 'all']).optional();

export const gitTools = [
  defineTool({
    name: 'git_get_status',
    title: 'Git status',
    description: 'Team-wide git picture: default branch head, active branches with who is on them, open PRs and latest build/test per branch. (Your local working tree: use git yourself.)',
    scope: 'read',
    core: true,
    input: { project },
    handler: async (ctx, a) => ctx.services.git.status(ctx.actor, await projectOf(ctx, a.project)),
  }),
  defineTool({
    name: 'git_get_recent_commits',
    title: 'Recent commits',
    description: 'Recent pushed commits with author, branch, linked task and files.',
    scope: 'read',
    core: true,
    input: { project, branch: z.string().max(200).optional(), limit: limitArg(100), since: sinceArg, author: z.string().max(60).optional() },
    handler: async (ctx, a) => {
      const since = parseSince(a.since, ctx.services.deps.clock.now());
      return ctx.services.git.recentCommits(ctx.actor, await projectOf(ctx, a.project), {
        ...(a.branch ? { branch: a.branch } : {}),
        limit: a.limit ?? 20,
        ...(since ? { since } : {}),
        ...(a.author ? { author: a.author } : {}),
      });
    },
  }),
  defineTool({
    name: 'git_get_branch_activity',
    title: 'Branch activity',
    description: 'Branches by last push, with pusher, agents on them and linked tasks.',
    scope: 'read',
    input: { project, limit: limitArg(100) },
    handler: async (ctx, a) => ctx.services.git.branchActivity(ctx.actor, await projectOf(ctx, a.project), a.limit ?? 20),
  }),
  defineTool({
    name: 'git_get_commit',
    title: 'Get commit',
    description: 'One commit with changed files and stats.',
    scope: 'read',
    input: { project, sha: z.string().min(4).max(64) },
    handler: async (ctx, a) => ctx.services.git.getCommit(ctx.actor, await projectOf(ctx, a.project), a.sha),
  }),
  defineTool({
    name: 'git_get_changed_files',
    title: 'Changed files',
    description: 'Files changed between two refs (branches, tags or commits) on GitHub.',
    scope: 'read',
    input: { project, base: z.string().min(1).max(200), head: z.string().min(1).max(200), repo: z.string().max(200).optional() },
    handler: async (ctx, a) => ctx.services.git.changedFiles(ctx.actor, await projectOf(ctx, a.project), a.base, a.head, a.repo),
  }),
  defineTool({
    name: 'github_get_issues',
    title: 'GitHub issues',
    description: 'Issues of the project repositories.',
    scope: 'read',
    input: { project, state, limit: limitArg(100) },
    handler: async (ctx, a) => ctx.services.git.issues(ctx.actor, await projectOf(ctx, a.project), a.state ?? 'open', a.limit ?? 30),
  }),
  defineTool({
    name: 'github_get_pull_requests',
    title: 'GitHub pull requests',
    description: 'Pull requests of the project repositories.',
    scope: 'read',
    input: { project, state, limit: limitArg(100) },
    handler: async (ctx, a) => ctx.services.git.pulls(ctx.actor, await projectOf(ctx, a.project), a.state ?? 'open', a.limit ?? 30),
  }),
  defineTool({
    name: 'github_create_issue',
    title: 'Create GitHub issue',
    description: 'Open a GitHub issue (optionally linked to a task).',
    scope: 'write',
    input: { project, title: z.string().min(1).max(250), body: z.string().max(20_000).optional(), labels: z.array(z.string().max(50)).max(10).optional(), taskId: z.number().int().positive().optional(), repo: z.string().max(200).optional() },
    handler: async (ctx, a) => {
      const { project: p, ...input } = a;
      return ctx.services.git.createIssue(ctx.actor, await projectOf(ctx, p), input);
    },
  }),
  defineTool({
    name: 'github_link_task',
    title: 'Link task to GitHub',
    description: 'Link a task to a GitHub issue and/or pull request.',
    scope: 'write',
    input: { taskId: taskIdArg, issue: z.number().int().positive().optional(), pullRequest: z.number().int().positive().optional() },
    handler: (ctx, a) => ctx.services.git.linkTask(ctx.actor, a.taskId, a),
  }),
  defineTool({
    name: 'github_get_recent_activity',
    title: 'GitHub activity',
    description: 'Recent pushes, merges, pull requests, reviews, issues and branches.',
    scope: 'read',
    input: { project, limit: limitArg(100) },
    handler: async (ctx, a) => ctx.services.git.recentActivity(ctx.actor, await projectOf(ctx, a.project), a.limit ?? 30),
  }),
];
