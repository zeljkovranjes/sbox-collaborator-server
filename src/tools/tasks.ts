import * as z from 'zod';
import { TASK_PRIORITIES, TASK_STATUSES } from '../services/tasks.js';
import { defineTool, limitArg, projectOf, taskIdArg } from './registry.js';

const priority = z.enum(TASK_PRIORITIES);
const files = z.array(z.string().max(512)).max(100);

export const taskTools = [
  defineTool({
    name: 'task_create',
    title: 'Create task',
    description: 'Add a task to the shared board. Keep titles short; put detail in description.',
    scope: 'write',
    core: true,
    input: {
      project: z.string().max(48).optional(),
      title: z.string().min(1).max(200),
      description: z.string().max(8000).optional(),
      priority: priority.optional(),
      status: z.enum(['backlog', 'available']).optional(),
      relatedFiles: files.optional(),
      relatedAssets: files.optional(),
      dependsOn: z.array(z.number().int().positive()).max(20).optional(),
      labels: z.array(z.string().max(40)).max(10).optional(),
      branch: z.string().max(200).optional(),
      githubIssue: z.number().int().positive().optional(),
    },
    handler: async (ctx, a) => ctx.services.tasks.create(ctx.actor, { ...a, project: await projectOf(ctx, a.project) }),
  }),
  defineTool({
    name: 'task_list',
    title: 'List tasks',
    description: 'List tasks (default: everything not done, plus done in the last week), sorted by status then priority. Filter by status, owner, mine or a text query.',
    scope: 'read',
    core: true,
    input: {
      project: z.string().max(48).optional(),
      status: z.array(z.enum(TASK_STATUSES)).max(7).optional(),
      ownerId: z.string().max(60).optional(),
      mine: z.boolean().optional(),
      query: z.string().max(200).optional(),
      limit: limitArg(200),
    },
    handler: async (ctx, a) => {
      const { project, ...filter } = a;
      return ctx.services.tasks.list(ctx.actor, await projectOf(ctx, project), filter);
    },
  }),
  defineTool({
    name: 'task_get',
    title: 'Get task',
    description: 'One task with its dependencies, active reservations and change announcements.',
    scope: 'read',
    core: true,
    input: { taskId: taskIdArg },
    handler: async (ctx, a) => {
      const task = await ctx.services.tasks.get(ctx.actor, a.taskId);
      const [dependencies, reservations, changes] = await Promise.all([
        task.dependsOn.length ? Promise.all(task.dependsOn.map((id) => ctx.services.tasks.get(ctx.actor, id).then((t) => ({ id: t.id, title: t.title, status: t.status })).catch(() => ({ id, missing: true })))) : [],
        ctx.services.reservations.list(ctx.actor, task.projectId).then((all) => all.filter((r) => r.taskId === task.id)),
        ctx.services.deps.db.selectFrom('changes').selectAll().where('taskId', '=', task.id).orderBy('startedAt', 'desc').limit(10).execute().then((rows) => ctx.services.changes.view(rows)),
      ]);
      return { ...task, dependencies, reservations, changes };
    },
  }),
  defineTool({
    name: 'task_claim',
    title: 'Claim task',
    description:
      'Claim a task for yourself. Atomic: if someone else already owns it you get a conflict naming them – coordinate instead of working on it. force=true (with reason) takes over a task whose owner is gone and notifies them.',
    scope: 'write',
    core: true,
    input: { taskId: taskIdArg, branch: z.string().max(200).optional(), force: z.boolean().optional(), reason: z.string().max(500).optional() },
    handler: async (ctx, a) => {
      const { task, warnings } = await ctx.services.tasks.claim(ctx.actor, a.taskId, a);
      return { ...task, ...(warnings.length ? { warnings } : {}), next: 'Reserve the files you will change (file_reserve) and set status (agent_set_status).' };
    },
  }),
  defineTool({
    name: 'task_update',
    title: 'Update task',
    description: 'Update a task (status, details, files, links). Pass expectedVersion to fail instead of overwriting a concurrent edit.',
    scope: 'write',
    core: true,
    input: {
      taskId: taskIdArg,
      status: z.enum(TASK_STATUSES).optional(),
      title: z.string().min(1).max(200).optional(),
      description: z.string().max(8000).optional(),
      priority: priority.optional(),
      relatedFiles: files.optional(),
      relatedAssets: files.optional(),
      dependsOn: z.array(z.number().int().positive()).max(20).optional(),
      labels: z.array(z.string().max(40)).max(10).optional(),
      branch: z.string().max(200).nullable().optional(),
      githubIssue: z.number().int().positive().nullable().optional(),
      githubPr: z.number().int().positive().nullable().optional(),
      expectedVersion: z.number().int().positive().optional(),
    },
    handler: (ctx, a) => {
      const { taskId, ...patch } = a;
      return ctx.services.tasks.update(ctx.actor, taskId, patch);
    },
  }),
  defineTool({
    name: 'task_block',
    title: 'Block task',
    description: 'Mark your task blocked with the reason. Shows up as a blocker for the whole team.',
    scope: 'write',
    core: true,
    input: { taskId: taskIdArg, reason: z.string().min(1).max(1000) },
    handler: (ctx, a) => ctx.services.tasks.block(ctx.actor, a.taskId, a.reason),
  }),
  defineTool({
    name: 'task_release',
    title: 'Release task',
    description: 'Give a task back (status available or backlog). Also releases reservations made for it.',
    scope: 'write',
    core: true,
    input: { taskId: taskIdArg, reason: z.string().max(500).optional(), status: z.enum(['available', 'backlog']).optional() },
    handler: (ctx, a) => ctx.services.tasks.release(ctx.actor, a.taskId, a),
  }),
  defineTool({
    name: 'task_complete',
    title: 'Complete task',
    description: 'Finish a task with a short completion summary (status done, or review). Releases its reservations. Publish change_complete for the details.',
    scope: 'write',
    core: true,
    input: { taskId: taskIdArg, summary: z.string().min(1).max(4000), commitSha: z.string().max(64).optional(), status: z.enum(['done', 'review']).optional() },
    handler: (ctx, a) => ctx.services.tasks.complete(ctx.actor, a.taskId, a),
  }),
];
