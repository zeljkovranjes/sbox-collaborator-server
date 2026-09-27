import { errorFields, log } from '../lib/log.js';
import type { McpGateway } from '../mcp/server.js';
import type { Services } from '../services/index.js';

/** Periodic housekeeping: offline agents, expired reservations, idle MCP sessions, old device codes. */
export class Sweeper {
  #timer: NodeJS.Timeout | null = null;
  #running = false;

  constructor(
    private readonly services: Services,
    private readonly mcp: McpGateway | null,
    private readonly intervalMs = 30_000,
  ) {}

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.runOnce(), this.intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  async runOnce(): Promise<{ offline: number; released: number }> {
    if (this.#running) return { offline: 0, released: 0 };
    this.#running = true;
    try {
      const offline = await this.services.agents.sweepOffline();
      const released = await this.services.reservations.sweep();
      await this.services.device.sweep();
      await this.services.summary.weeklyDigests();
      await this.mcp?.sweep();
      if (offline || released) log.info('sweep', { offline, released });
      return { offline, released };
    } catch (error) {
      log.error('sweep failed', errorFields(error));
      return { offline: 0, released: 0 };
    } finally {
      this.#running = false;
    }
  }
}
