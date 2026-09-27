import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import * as z from 'zod';
import { log, errorFields } from '../lib/log.js';
import type { Actor } from '../services/context.js';
import type { Services } from '../services/index.js';
import { toolsFor, type ToolProfile } from '../tools/index.js';
import { errorText, renderResult, runTool } from '../tools/registry.js';
import { SERVER_INSTRUCTIONS, startWorkPrompt } from './instructions.js';
import { AppError } from '../lib/errors.js';

interface Session {
  id: string;
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  actor: Actor;
  agentId: string | null;
  lastSeen: number;
}

const IDLE_SESSION_MS = 2 * 60 * 60_000;

/**
 * MCP over Streamable HTTP. Every request is authenticated with the caller's access key; a
 * session is bound to the key that opened it, and remembers the agent registered through it.
 */
export class McpGateway {
  #sessions = new Map<string, Session>();
  #version: string;

  constructor(
    private readonly services: Services,
    version: string,
  ) {
    this.#version = version;
  }

  get sessionCount(): number {
    return this.#sessions.size;
  }

  #createServer(session: () => Session | undefined, profile: ToolProfile): McpServer {
    const server = new McpServer(
      { name: 'sbox-collaborator', title: `${this.services.deps.config.serverName} (s&box collaboration)`, version: this.#version },
      { instructions: SERVER_INSTRUCTIONS, capabilities: { logging: {} } },
    );
    for (const tool of toolsFor(profile)) {
      server.registerTool(
        tool.name,
        {
          title: tool.title,
          description: tool.description,
          inputSchema: tool.input,
          annotations: { readOnlyHint: tool.scope === 'read', destructiveHint: false, openWorldHint: tool.name.startsWith('github_') },
        },
        async (args: unknown) => {
          const current = session();
          if (!current) return { isError: true, content: [{ type: 'text' as const, text: 'unauthorized: session expired, reconnect' }] };
          try {
            const outcome = await runTool(tool, this.services, { ...current.actor, agentId: current.agentId }, args, (agentId) => (current.agentId = agentId));
            return { content: [{ type: 'text' as const, text: renderResult(outcome) }] };
          } catch (error) {
            if (!(error instanceof AppError)) log.error('tool failed', { tool: tool.name, ...errorFields(error) });
            return { isError: true, content: [{ type: 'text' as const, text: errorText(error) }] };
          }
        },
      );
    }
    server.registerPrompt(
      'start_work',
      {
        title: 'Start work with the team',
        description: 'Runs the team workflow (register, sync, messages, claim, reserve) for a task.',
        argsSchema: { task: z.string().optional() },
      },
      ({ task }) => ({ messages: [{ role: 'user', content: { type: 'text', text: startWorkPrompt(task) } }] }),
    );
    return server;
  }

  /** POST/GET/DELETE /mcp. `actor` is already authenticated by the HTTP layer. */
  async handle(req: Request, res: Response, actor: Actor): Promise<void> {
    const sessionId = req.header('mcp-session-id');
    const now = this.services.deps.clock.now();
    if (sessionId) {
      const session = this.#sessions.get(sessionId);
      if (!session) {
        res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found; start a new session' }, id: null });
        return;
      }
      if (session.actor.developerId !== actor.developerId || session.actor.keyId !== actor.keyId) {
        res.status(403).json({ jsonrpc: '2.0', error: { code: -32003, message: 'Session belongs to another key' }, id: null });
        return;
      }
      session.actor = actor; // pick up scope/project changes and revocations immediately
      session.lastSeen = now;
      await session.transport.handleRequest(req, res, req.body);
      return;
    }

    if (req.method !== 'POST' || !isInitializeRequest(req.body)) {
      res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Missing mcp-session-id (send initialize first)' }, id: null });
      return;
    }

    const profile: ToolProfile = req.query.profile === 'core' ? 'core' : 'full';
    let created: Session | undefined;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        if (created) {
          created.id = id;
          this.#sessions.set(id, created);
        }
      },
      onsessionclosed: (id) => void this.#close(id),
    });
    const server = this.#createServer(() => created, profile);
    created = { id: '', transport, server, actor, agentId: null, lastSeen: now };
    transport.onclose = () => {
      if (created?.id) this.#sessions.delete(created.id);
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }

  async #close(id: string): Promise<void> {
    const session = this.#sessions.get(id);
    if (!session) return;
    this.#sessions.delete(id);
    if (session.agentId) await this.services.agents.disconnected(session.agentId);
    await session.server.close().catch(() => undefined);
  }

  /** Drops sessions nobody used for a while (clients reconnect transparently). */
  async sweep(): Promise<void> {
    const cutoff = this.services.deps.clock.now() - IDLE_SESSION_MS;
    for (const [id, session] of this.#sessions) if (session.lastSeen < cutoff) await this.#close(id);
  }

  async closeAll(): Promise<void> {
    for (const id of [...this.#sessions.keys()]) await this.#close(id);
  }
}
