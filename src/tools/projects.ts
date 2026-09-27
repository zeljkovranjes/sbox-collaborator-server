import * as z from 'zod';
import { parseSince } from '../lib/time.js';
import { defineTool, limitArg, projectArg, projectOf, sinceArg } from './registry.js';

const importantDirs = z.array(z.object({ path: z.string().min(1).max(300), description: z.string().max(300) })).max(40);

export const projectTools = [
  defineTool({
    name: 'project_list',
    title: 'List projects',
    description: 'List the s&box projects on this server that you can access.',
    scope: 'read',
    core: true,
    input: {},
    handler: (ctx) => ctx.services.projects.list(ctx.actor),
  }),
  defineTool({
    name: 'project_get',
    title: 'Get project',
    description: 'Get one project: repos, default branch, package ident, summary, conventions, milestone and important directories.',
    scope: 'read',
    input: { project: projectArg },
    handler: async (ctx, a) => ctx.services.projects.get(ctx.actor, await projectOf(ctx, a.project)),
  }),
  defineTool({
    name: 'project_get_context',
    title: 'Get project context',
    description: 'Project summary, conventions, milestone and important directories plus who is active right now. Lighter than project_sync_context.',
    scope: 'read',
    input: { project: projectArg },
    handler: async (ctx, a) => {
      const id = await projectOf(ctx, a.project);
      const [project, agents] = await Promise.all([ctx.services.projects.get(ctx.actor, id), ctx.services.agents.listActive(ctx.actor, id)]);
      return {
        ...project,
        activeDevelopers: [...new Set(agents.map((x) => x.developerName))],
        activeAgents: agents.map((x) => ({ id: x.id, label: x.label, developer: x.developerName, status: x.status, task: x.currentTaskTitle, branch: x.branch })),
      };
    },
  }),
  defineTool({
    name: 'project_update_context',
    title: 'Update project context',
    description:
      'Update shared project context: summary/architecture, coding conventions, current milestone, important directories, structure, repos, package ident. Keep text concise – it is shown to every agent.',
    scope: 'write',
    input: {
      project: projectArg,
      name: z.string().min(1).max(80).optional(),
      kind: z.enum(['game', 'library', 'tool']).optional(),
      summary: z.string().max(6000).optional().describe('Architecture summary'),
      conventions: z.string().max(6000).optional().describe('Coding and s&box conventions'),
      milestone: z.string().max(300).optional(),
      importantDirs: importantDirs.optional(),
      structure: z.string().max(6000).optional().describe('Local project structure'),
      packageIdent: z.string().max(100).optional(),
      defaultBranch: z.string().max(100).optional(),
      repos: z.array(z.string()).max(10).optional().describe('GitHub repos as owner/name'),
      discordWebhookUrl: z.string().max(300).nullable().optional().describe('Discord webhook for this project ("" or null clears it). Stored encrypted.'),
    },
    handler: async (ctx, a) => {
      const { project, ...patch } = a;
      return ctx.services.projects.update(ctx.actor, await projectOf(ctx, project), patch);
    },
  }),
  defineTool({
    name: 'project_create',
    title: 'Create project',
    description: 'Create a new project (admin).',
    scope: 'admin',
    input: {
      id: z.string().min(2).max(48).describe('Lowercase id, e.g. "sailing"'),
      name: z.string().min(1).max(80),
      kind: z.enum(['game', 'library', 'tool']),
      repos: z.array(z.string()).max(10).optional(),
      defaultBranch: z.string().max(100).optional(),
      packageIdent: z.string().max(100).optional(),
      summary: z.string().max(6000).optional(),
    },
    handler: (ctx, a) => ctx.services.projects.create(ctx.actor, a),
  }),
  defineTool({
    name: 'project_get_activity',
    title: 'Project activity',
    description: 'Chronological project activity (newest first).',
    scope: 'read',
    input: { project: projectArg, limit: limitArg(200), since: sinceArg },
    handler: async (ctx, a) => {
      const since = parseSince(a.since, ctx.services.deps.clock.now());
      return ctx.services.activity.recent(await projectOf(ctx, a.project), { limit: a.limit ?? 50, ...(since ? { since } : {}) });
    },
  }),
  defineTool({
    name: 'project_get_recent_changes',
    title: 'Recent change announcements',
    description: 'Structured change announcements (files, API changes, breaking changes, tests, follow-ups) published by agents.',
    scope: 'read',
    input: { project: projectArg, limit: limitArg(100), since: sinceArg, includeStarted: z.boolean().optional() },
    handler: async (ctx, a) => {
      const since = parseSince(a.since, ctx.services.deps.clock.now());
      return ctx.services.changes.recent(ctx.actor, await projectOf(ctx, a.project), { limit: a.limit ?? 20, ...(since ? { since } : {}), includeStarted: a.includeStarted ?? false });
    },
  }),
  defineTool({
    name: 'project_sync_context',
    title: 'Sync project context',
    description:
      'START HERE before any work. Returns a compact packet: project summary and conventions, milestone, who is doing what, tasks, file reservations, recent commits, teammates’ changes (API/breaking), relevant decisions and knowledge, unread messages, blockers and build status. Pass focus (what you are about to do) and paths to rank what matters.',
    scope: 'read',
    core: true,
    input: {
      project: projectArg,
      focus: z.string().max(1000).optional().describe('What you are about to work on, e.g. "sailing physics buoyancy"'),
      paths: z.array(z.string().max(512)).max(50).optional().describe('Files/directories you expect to touch'),
      format: z.enum(['text', 'json']).optional().describe('text (default, compact markdown) or json'),
    },
    handler: async (ctx, a) => {
      const packet = await ctx.services.sync.context(ctx.actor, await projectOf(ctx, a.project), {
        ...(a.focus ? { focus: a.focus } : {}),
        ...(a.paths ? { paths: a.paths } : {}),
      });
      return a.format === 'json' ? packet : ctx.services.sync.renderContext(packet);
    },
  }),
];
