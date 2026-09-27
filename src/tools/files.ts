import * as z from 'zod';
import { defineTool, pathsArg, projectOf } from './registry.js';

export const fileTools = [
  defineTool({
    name: 'file_reserve',
    title: 'Reserve files',
    description:
      'Reserve files or directories (trailing "/") before major edits, e.g. ["Code/BoatController.cs", "Assets/Ships/"]. Advisory: paths another developer holds are NOT reserved and come back as conflicts – do not edit them without coordinating. Reservations expire (ttlMinutes, default 4h) and drop when your agent goes offline.',
    scope: 'write',
    core: true,
    input: {
      project: z.string().max(48).optional(),
      paths: pathsArg.min(1),
      reason: z.string().min(1).max(500),
      taskId: z.number().int().positive().optional(),
      branch: z.string().max(200).optional(),
      ttlMinutes: z.number().int().min(1).max(4320).optional(),
      force: z.boolean().optional().describe('Reserve even over conflicts (owners are warned). Only after agreeing with them.'),
    },
    handler: async (ctx, a) => ctx.services.reservations.reserve(ctx.actor, { ...a, project: await projectOf(ctx, a.project) }),
  }),
  defineTool({
    name: 'file_release',
    title: 'Release files',
    description: 'Release your reservations: by paths, by reservation ids, or all=true (all of this agent’s).',
    scope: 'write',
    core: true,
    input: { project: z.string().max(48).optional(), paths: pathsArg.optional(), reservationIds: z.array(z.string().max(40)).max(100).optional(), all: z.boolean().optional() },
    handler: async (ctx, a) => ctx.services.reservations.release(ctx.actor, { ...a, project: await projectOf(ctx, a.project) }),
  }),
  defineTool({
    name: 'file_list_reservations',
    title: 'List reservations',
    description: 'Active reservations, optionally only those overlapping a path, of one developer, or yours.',
    scope: 'read',
    core: true,
    input: { project: z.string().max(48).optional(), path: z.string().max(512).optional(), developerId: z.string().max(60).optional(), mine: z.boolean().optional() },
    handler: async (ctx, a) => {
      const { project, ...filter } = a;
      return ctx.services.reservations.list(ctx.actor, await projectOf(ctx, project), filter);
    },
  }),
  defineTool({
    name: 'file_check_conflict',
    title: 'Check file conflicts',
    description: 'Before editing, check whether any of these paths are reserved by another developer. Returns a clear warning with owner and task.',
    scope: 'read',
    core: true,
    input: { project: z.string().max(48).optional(), paths: pathsArg.min(1) },
    handler: async (ctx, a) => ctx.services.reservations.checkConflict(ctx.actor, await projectOf(ctx, a.project), a.paths),
  }),
];
