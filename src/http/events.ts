import type { Request, Response } from 'express';
import type { CollabEvent } from '../events/bus.js';
import { invalid } from '../lib/errors.js';
import { canAccessProject, requireScope } from '../services/context.js';
import type { Services } from '../services/index.js';
import { queryString, requireActor } from './util.js';

const PING_MS = 25_000;

/** GET /api/events?project=<id> – Server-Sent Events for dashboards and the s&box editor. */
export function eventStream(services: Services) {
  return (req: Request, res: Response) => {
    const actor = requireActor(req);
    requireScope(actor, 'read');
    const project = queryString(req, 'project');
    if (project && !canAccessProject(actor, project)) throw invalid(`No access to project "${project}"`);

    res.status(200);
    res.setHeader('content-type', 'text/event-stream; charset=utf-8');
    res.setHeader('cache-control', 'no-cache, no-transform');
    res.setHeader('connection', 'keep-alive');
    res.setHeader('x-accel-buffering', 'no'); // nginx: do not buffer the stream
    res.flushHeaders();
    res.write(`retry: 5000\n: connected\n\n`);

    const send = (event: CollabEvent) => {
      if (project && event.projectId !== project) return;
      if (!canAccessProject(actor, event.projectId)) return;
      if (event.audience && !event.audience.includes(actor.developerId)) return;
      const { audience: _audience, ...payload } = event;
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(payload)}\n\n`);
    };
    const unsubscribe = services.deps.bus.subscribe(send);
    const ping = setInterval(() => res.write(': ping\n\n'), PING_MS);
    const close = () => {
      clearInterval(ping);
      unsubscribe();
    };
    req.on('close', close);
    res.on('error', close);
  };
}
