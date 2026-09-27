import * as z from 'zod';
import { invalid } from '../lib/errors.js';
import { AGENT_STATUSES } from '../services/agents.js';
import { defineTool, limitArg, projectOf, type ToolContext } from './registry.js';

const status = z.enum(AGENT_STATUSES);
const statusFields = {
  note: z.string().max(280).optional().describe('One line on what you are doing'),
  currentTaskId: z.number().int().positive().nullable().optional(),
  branch: z.string().max(200).nullable().optional(),
  files: z.array(z.string().max(512)).max(50).optional().describe('Files you are editing right now'),
};

function requireAgent(ctx: ToolContext) {
  if (!ctx.agent) throw invalid('Register first: call agent_register (then this connection is your agent).');
  return ctx.agent;
}

export const agentTools = [
  defineTool({
    name: 'agent_register',
    title: 'Register agent',
    description:
      'Register this coding agent session so teammates see you. Call once at the start (reconnects reuse the same agent and keep your task and reservations). clientType: claude-code, codex, cursor, opencode, sbox-editor or other.',
    scope: 'write',
    core: true,
    input: {
      project: z.string().min(1).max(48).optional(),
      clientType: z.string().min(1).max(40),
      machine: z.string().max(80).optional().describe('Computer name'),
      model: z.string().max(80).optional().describe('Model name, e.g. claude-opus-5-5'),
      label: z.string().max(80).optional(),
      branch: z.string().max(200).optional(),
      resumeAgentId: z.string().max(40).optional(),
    },
    handler: async (ctx, a) => {
      const project = await projectOf(ctx, a.project);
      const agent = await ctx.services.agents.register(ctx.actor, { ...a, project });
      ctx.bindAgent?.(agent.id);
      return { ...agent, next: 'Now call project_sync_context with your focus, then message_get_unread.' };
    },
  }),
  defineTool({
    name: 'agent_heartbeat',
    title: 'Heartbeat',
    description: 'Keep your presence and file reservations alive during long work (any tool call also counts). Optionally update status.',
    scope: 'write',
    core: true,
    input: { status: status.optional(), ...statusFields },
    handler: async (ctx, a) => {
      const agent = requireAgent(ctx);
      const updated = await ctx.services.agents.heartbeat(ctx.actor, agent.id, { ...a, ...(a.note !== undefined ? { note: a.note } : {}) });
      const unread = await ctx.services.messages.unreadSummary(ctx.actor, [agent.projectId]);
      return { agent: updated, unreadMessages: unread.count, notices: [] as string[] };
    },
  }),
  defineTool({
    name: 'agent_set_status',
    title: 'Set status',
    description: 'Publish what you are doing: idle, planning, working, testing, blocked, reviewing. Include the task, branch and files being edited.',
    scope: 'write',
    core: true,
    input: { status, ...statusFields },
    handler: (ctx, a) => ctx.services.agents.setStatus(ctx.actor, requireAgent(ctx).id, a),
  }),
  defineTool({
    name: 'agent_list_active',
    title: 'Active agents',
    description: 'Who is online in a project: developer, client, status, task, branch and files being edited.',
    scope: 'read',
    core: true,
    input: { project: z.string().min(1).max(48).optional() },
    handler: async (ctx, a) => ctx.services.agents.listActive(ctx.actor, await projectOf(ctx, a.project)),
  }),
  defineTool({
    name: 'agent_get_activity',
    title: 'Agent activity',
    description: 'Recent activity of one agent or developer (defaults to you).',
    scope: 'read',
    input: { agentId: z.string().max(40).optional(), developerId: z.string().max(60).optional(), limit: limitArg(200) },
    handler: (ctx, a) =>
      ctx.services.activity.byActor({
        ...(a.agentId ? { agentId: a.agentId } : {}),
        developerId: a.developerId ?? (a.agentId ? undefined : ctx.actor.developerId),
        projectIds: ctx.actor.projectIds,
        limit: a.limit ?? 50,
      } as Parameters<typeof ctx.services.activity.byActor>[0]),
  }),
];
