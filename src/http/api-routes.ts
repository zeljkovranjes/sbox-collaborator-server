import express, { Router } from 'express';
import * as z from 'zod';
import { SCOPES } from '../auth/accounts.js';
import { AppError, forbidden, invalid, notFound } from '../lib/errors.js';
import { requireProjectAccess, requireScope, type Scope } from '../services/context.js';
import type { Services } from '../services/index.js';
import { ALL_TOOLS, TOOLS_BY_NAME } from '../tools/index.js';
import { runTool } from '../tools/registry.js';
import { eventStream } from './events.js';
import { ok, queryString, requireActor } from './util.js';

function parse<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body ?? {});
  if (!result.success) throw invalid(result.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return result.data;
}

const scopes = z.array(z.enum(SCOPES as [Scope, ...Scope[]])).min(1).max(3);

export function apiRoutes(services: Services): Router {
  const router = Router();

  const requireAdmin = (req: express.Request) => {
    const actor = requireActor(req);
    requireScope(actor, 'admin');
    if (actor.role !== 'admin') throw forbidden('Admins only');
    return actor;
  };

  // ---- identity ---------------------------------------------------------------------------------

  router.get('/api/me', async (req, res) => {
    const actor = requireActor(req);
    const developer = await services.directory.get(actor.developerId);
    const key = actor.keyId ? (await services.accounts.listAccessKeys(actor.developerId)).find((k) => k.id === actor.keyId) ?? null : null;
    ok(res, { developer, key, scopes: actor.scopes, projectIds: actor.projectIds, viaSession: !!req.viaCookie });
  });

  // ---- tools over HTTP --------------------------------------------------------------------------

  router.get('/api/tools', (req, res) => {
    requireActor(req);
    ok(
      res,
      ALL_TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, scope: t.scope, core: !!t.core, inputSchema: z.toJSONSchema(z.object(t.input)) })),
    );
  });

  router.post('/api/tools/:name', async (req, res) => {
    const actor = requireActor(req);
    const tool = TOOLS_BY_NAME.get(String(req.params.name));
    if (!tool) throw notFound(`Tool "${req.params.name}"`);
    const outcome = await runTool(tool, services, actor, req.body ?? {});
    ok(res, outcome.result, outcome.notices);
  });

  // ---- dashboard / editor packets -------------------------------------------------------------------

  router.get('/api/overview', async (req, res) => {
    const actor = requireActor(req);
    requireScope(actor, 'read');
    const project = queryString(req, 'project');
    if (!project) throw invalid('Pass ?project=<id>');
    const agent = await services.agents.resolve(actor, project);
    if (agent) await services.agents.touch(agent.id);
    ok(res, await services.sync.overview(actor, project));
  });

  router.get('/api/messages', async (req, res) => {
    const actor = requireActor(req);
    requireScope(actor, 'read');
    const project = queryString(req, 'project');
    if (!project) throw invalid('Pass ?project=<id>');
    ok(res, await services.messages.recent(actor, project, Number(queryString(req, 'limit') ?? 50)));
  });

  router.get('/api/events', eventStream(services));

  router.post(
    '/api/assets/bulk',
    async (req, res) => {
      const actor = requireActor(req);
      requireScope(actor, 'write');
      const body = parse(
        z.object({
          project: z.string().min(1).max(48),
          fullScan: z.boolean().optional(),
          assets: z.array(z.object({ path: z.string().min(1).max(512), dependencies: z.array(z.string().max(512)).max(2000).optional(), metadata: z.record(z.string(), z.unknown()).optional() })).max(20_000),
          removed: z.array(z.string().max(512)).max(20_000).optional(),
        }),
        req.body,
      );
      requireProjectAccess(actor, body.project);
      ok(res, await services.assets.bulk(actor, body.project, body));
    },
  );

  // ---- my access keys and sessions ------------------------------------------------------------------

  router.get('/api/keys', async (req, res) => {
    const actor = requireActor(req);
    ok(res, await services.accounts.listAccessKeys(actor.developerId));
  });

  router.post('/api/keys', async (req, res) => {
    const actor = requireActor(req);
    if (actor.keyId && !actor.scopes.includes('admin')) throw forbidden('Create keys from the dashboard (signed in), not with another key');
    const body = parse(z.object({ name: z.string().min(1).max(80), scopes: scopes.optional(), projectIds: z.array(z.string()).max(50).nullable().optional(), expiresInDays: z.number().int().min(1).max(3650).nullable().optional() }), req.body);
    ok(res, await services.accounts.createAccessKey(actor.developerId, { name: body.name, scopes: body.scopes ?? ['write'], projectIds: body.projectIds ?? null, via: 'dashboard', expiresInDays: body.expiresInDays ?? null }));
  });

  router.delete('/api/keys/:id', async (req, res) => {
    const actor = requireActor(req);
    ok(res, await services.accounts.revokeAccessKey(actor, String(req.params.id)));
  });

  router.get('/api/sessions', async (req, res) => {
    const actor = requireActor(req);
    ok(res, await services.sessions.list(actor.developerId));
  });

  router.delete('/api/sessions/:id', async (req, res) => {
    const actor = requireActor(req);
    const mine = (await services.sessions.list(actor.developerId)).some((s) => s.id === req.params.id);
    if (!mine && actor.role !== 'admin') throw notFound('Session');
    await services.sessions.revoke(String(req.params.id));
    ok(res, { revoked: true });
  });

  // ---- administration --------------------------------------------------------------------------------

  router.get('/api/admin/developers', async (req, res) => {
    requireAdmin(req);
    ok(res, await services.accounts.listDevelopers());
  });

  router.post('/api/admin/developers', async (req, res) => {
    requireAdmin(req);
    const body = parse(z.object({ id: z.string().max(48).optional(), displayName: z.string().min(1).max(60), githubLogin: z.string().max(60).nullable().optional(), role: z.enum(['admin', 'member']).optional(), projectIds: z.array(z.string()).nullable().optional() }), req.body);
    ok(res, await services.accounts.createDeveloper(body));
  });

  router.patch('/api/admin/developers/:id', async (req, res) => {
    const actor = requireAdmin(req);
    const body = parse(z.object({ displayName: z.string().min(1).max(60).optional(), githubLogin: z.string().max(60).nullable().optional(), role: z.enum(['admin', 'member']).optional(), projectIds: z.array(z.string()).nullable().optional(), disabled: z.boolean().optional() }), req.body);
    if (req.params.id === actor.developerId && (body.disabled || body.role === 'member')) throw invalid('You cannot demote or disable yourself');
    ok(res, await services.accounts.updateDeveloper(String(req.params.id), body));
  });

  router.get('/api/admin/keys', async (req, res) => {
    requireAdmin(req);
    ok(res, await services.accounts.listAccessKeys());
  });

  router.delete('/api/admin/keys/:id', async (req, res) => {
    const actor = requireAdmin(req);
    ok(res, await services.accounts.revokeAccessKey(actor, String(req.params.id)));
  });

  router.get('/api/admin/join-keys', async (req, res) => {
    requireAdmin(req);
    ok(res, await services.accounts.listJoinKeys());
  });

  router.post('/api/admin/join-keys', async (req, res) => {
    const actor = requireAdmin(req);
    const body = parse(
      z.object({
        name: z.string().min(1).max(80),
        role: z.enum(['admin', 'member']).optional(),
        githubLogin: z.string().max(60).nullable().optional(),
        maxUses: z.number().int().min(1).max(100).nullable().optional(),
        expiresInDays: z.number().int().min(1).max(365).nullable().optional(),
        projectIds: z.array(z.string()).nullable().optional(),
      }),
      req.body,
    );
    ok(res, await services.accounts.createJoinKey({ ...body, createdBy: actor.developerId }));
  });

  router.delete('/api/admin/join-keys/:id', async (req, res) => {
    requireAdmin(req);
    ok(res, await services.accounts.revokeJoinKey(String(req.params.id)));
  });

  router.get('/api/admin/status', async (req, res) => {
    requireAdmin(req);
    const config = services.deps.config;
    ok(res, {
      database: services.deps.database.dialect,
      publicUrl: config.publicUrl,
      githubToken: !!config.github.token,
      githubOAuth: !!(config.github.oauthClientId && config.github.oauthClientSecret),
      webhookSecret: !!config.github.webhookSecret,
      webhookUrl: `${config.publicUrl}/webhooks/github`,
      realtimeSubscribers: services.deps.bus.listenerCount,
      agentOfflineAfterMinutes: Math.round(config.agentOfflineAfterMs / 60_000),
      reservationGraceMinutes: Math.round(config.reservationGraceMs / 60_000),
    });
  });

  router.use('/api', (_req, _res, next) => next(new AppError('not_found', 'No such API endpoint')));
  return router;
}
