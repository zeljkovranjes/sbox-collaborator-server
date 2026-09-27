import * as z from 'zod';
import { ASSET_TYPES } from '../lib/sbox.js';
import { defineTool, limitArg, projectOf } from './registry.js';

const assetFields = {
  project: z.string().max(48).optional(),
  path: z.string().min(1).max(512).describe('Project-relative path, e.g. Assets/Ships/Ship.vmdl'),
  description: z.string().max(1000).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  dependencies: z.array(z.string().max(512)).max(500).optional().describe('Assets this one uses (Ship.vmdl → Ship.fbx, Ship.vmat)'),
  content: z.string().max(400_000).optional().describe('Text of a .vmdl/.vmat/.prefab/.scene/.sound to extract references from'),
  metadata: z.record(z.string(), z.unknown()).optional(),
};

export const assetTools = [
  defineTool({
    name: 'asset_search',
    title: 'Search assets',
    description: `Find s&box assets by name/path/tag/type. Types: ${ASSET_TYPES.join(', ')}.`,
    scope: 'read',
    core: true,
    input: { project: z.string().max(48).optional(), query: z.string().max(200).optional(), type: z.enum(ASSET_TYPES).optional(), tag: z.string().max(40).optional(), limit: limitArg(200) },
    handler: async (ctx, a) => {
      const { project, ...filter } = a;
      return ctx.services.assets.search(ctx.actor, await projectOf(ctx, project), filter);
    },
  }),
  defineTool({
    name: 'asset_get',
    title: 'Get asset',
    description: 'One asset with what it uses, what uses it, and who has it reserved.',
    scope: 'read',
    input: { project: z.string().max(48).optional(), path: z.string().min(1).max(512) },
    handler: async (ctx, a) => ctx.services.assets.get(ctx.actor, await projectOf(ctx, a.project), a.path),
  }),
  defineTool({
    name: 'asset_register',
    title: 'Register asset',
    description: 'Register or update an asset with description, tags and dependencies (or its text content, from which references are extracted).',
    scope: 'write',
    input: assetFields,
    handler: async (ctx, a) => {
      const { project, ...input } = a;
      return ctx.services.assets.register(ctx.actor, await projectOf(ctx, project), input);
    },
  }),
  defineTool({
    name: 'asset_update',
    title: 'Update asset',
    description: 'Update an already registered asset.',
    scope: 'write',
    input: assetFields,
    handler: async (ctx, a) => {
      const { project, ...input } = a;
      return ctx.services.assets.update(ctx.actor, await projectOf(ctx, project), input);
    },
  }),
  defineTool({
    name: 'asset_find_dependencies',
    title: 'Asset dependencies',
    description: 'Tree of what an asset uses (model → source mesh → materials → textures).',
    scope: 'read',
    input: { project: z.string().max(48).optional(), path: z.string().min(1).max(512), depth: z.number().int().min(1).max(6).optional() },
    handler: async (ctx, a) => ctx.services.assets.dependencies(ctx.actor, await projectOf(ctx, a.project), a.path, a.depth ?? 3),
  }),
  defineTool({
    name: 'asset_find_references',
    title: 'Asset references',
    description: 'Tree of what uses an asset – check this before renaming, moving or deleting it.',
    scope: 'read',
    input: { project: z.string().max(48).optional(), path: z.string().min(1).max(512), depth: z.number().int().min(1).max(6).optional() },
    handler: async (ctx, a) => ctx.services.assets.references(ctx.actor, await projectOf(ctx, a.project), a.path, a.depth ?? 2),
  }),
  defineTool({
    name: 'asset_recent_changes',
    title: 'Recent asset changes',
    description: 'Assets changed recently (from pushes and registrations), with commit and author.',
    scope: 'read',
    input: { project: z.string().max(48).optional(), limit: limitArg(100), type: z.enum(ASSET_TYPES).optional() },
    handler: async (ctx, a) => {
      const { project, ...filter } = a;
      return ctx.services.assets.recentChanges(ctx.actor, await projectOf(ctx, project), filter);
    },
  }),
];
