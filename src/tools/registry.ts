import * as z from 'zod';
import { AppError, invalid } from '../lib/errors.js';
import { compact } from '../lib/json.js';
import type { AgentRow } from '../db/schema.js';
import { requireScope, type Actor, type Scope } from '../services/context.js';
import type { Services } from '../services/index.js';

export interface ToolContext {
  actor: Actor;
  services: Services;
  /** The caller's live agent row, when it has one. */
  agent: AgentRow | null;
  /** Called when a tool (agent_register) establishes the agent for this connection. */
  bindAgent?: (agentId: string) => void;
}

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  scope: Scope;
  /** Kept in the reduced "core" profile for clients with tool limits. */
  core?: boolean;
  input: S;
  handler(ctx: ToolContext, args: z.infer<z.ZodObject<S>>): Promise<unknown>;
}

export function defineTool<S extends z.ZodRawShape>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

export type AnyTool = ToolDef<any>;

export interface ToolOutcome {
  result: unknown;
  notices: string[];
}

/** Resolves the project a call is about: explicit argument, the agent's project, or the only project. */
export async function projectOf(ctx: ToolContext, project: string | undefined): Promise<string> {
  if (project) return project;
  if (ctx.agent) return ctx.agent.projectId;
  const projects = await ctx.services.projects.list(ctx.actor);
  if (projects.length === 1) return projects[0]!.id;
  throw invalid(projects.length ? `Pass project (one of: ${projects.map((p) => p.id).join(', ')})` : 'No projects exist yet – an admin creates one in the dashboard or with project_create');
}

/**
 * Runs a tool for an authenticated actor: scope check, argument validation, agent resolution
 * (any call is a heartbeat), then the handler, then notices for the agent.
 */
export async function runTool(tool: AnyTool, services: Services, actor: Actor, rawArgs: unknown, bindAgent?: (agentId: string) => void): Promise<ToolOutcome> {
  requireScope(actor, tool.scope);
  // Clients often send null for "not set": drop nulls the schema does not accept.
  const args: Record<string, unknown> = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? { ...(rawArgs as Record<string, unknown>) } : {};
  for (const [key, value] of Object.entries(args)) {
    const field = (tool.input as Record<string, z.ZodType>)[key];
    if (value === null && field && !field.safeParse(null).success) delete args[key];
  }
  const parsed = z.object(tool.input).strict().safeParse(args);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(arguments)'}: ${i.message}`);
    throw invalid(`Invalid arguments for ${tool.name}: ${issues.join('; ')}`, { issues });
  }
  const agent = await services.agents.resolve(actor);
  const effective: Actor = { ...actor, agentId: agent?.id ?? null };
  if (agent) await services.agents.touch(agent.id);
  const ctx: ToolContext = { actor: effective, services, agent, ...(bindAgent ? { bindAgent } : {}) };
  const result = await tool.handler(ctx, parsed.data);
  const notices = await services.sync.notices(ctx.actor).catch(() => []);
  return { result, notices };
}

/** Text for MCP clients: strings pass through, everything else is compact JSON. */
export function renderResult(outcome: ToolOutcome): string {
  const body = typeof outcome.result === 'string' ? outcome.result : JSON.stringify(compact(outcome.result));
  return outcome.notices.length ? `${body}\n\n[team notices]\n${outcome.notices.join('\n')}` : body;
}

export function errorText(error: unknown): string {
  if (error instanceof AppError) return `${error.code}: ${error.message}`;
  return 'internal: the server hit an unexpected error (logged)';
}

// ---- shared argument schemas ----------------------------------------------------------------

export const projectArg = z.string().min(1).max(48).optional().describe('Project id. Defaults to your registered agent’s project.');
export const pathsArg = z.array(z.string().min(1).max(512)).max(200);
export const taskIdArg = z.number().int().positive().describe('Task number, e.g. 42 for #42');
export const limitArg = (max: number) => z.number().int().min(1).max(max).optional();
export const sinceArg = z.string().max(40).optional().describe('ISO date, epoch ms, or relative duration like "6h" / "3d"');
