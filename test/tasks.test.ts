import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '../src/lib/errors.js';
import { asAgent, DB_KINDS, MINUTE, world, type World } from './helpers.js';

describe.each(DB_KINDS)('task claiming (%s)', (kind) => {
  let w: World;
  afterEach(() => w?.close());

  it('lets exactly one of many concurrent claims win', async () => {
    w = await world(kind);
    const task = await w.services.tasks.create(w.chomnr, { project: 'sailing', title: 'Buoyancy rewrite' });
    const a = await asAgent(w, w.chomnr);
    const b = await asAgent(w, w.friend, 'codex');
    const attempts = Array.from({ length: 10 }, (_, i) => w.services.tasks.claim(i % 2 ? a : b, task.id));
    const results = await Promise.allSettled(attempts);
    const winners = results.filter((r) => r.status === 'fulfilled');
    const losers = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    // The same developer re-claiming its own task is idempotent; the other developer must always lose.
    const owner = (await w.services.tasks.get(w.chomnr, task.id)).ownerId;
    for (const win of winners) expect((win as PromiseFulfilledResult<{ task: { ownerId: string } }>).value.task.ownerId).toBe(owner);
    expect(winners.length).toBe(5);
    for (const loss of losers) {
      expect(loss.reason).toBeInstanceOf(AppError);
      expect((loss.reason as AppError).code).toBe('conflict');
    }
  });

  it('names the owner in the conflict and allows a forced takeover with notification', async () => {
    w = await world(kind);
    const task = await w.services.tasks.create(w.chomnr, { project: 'sailing', title: 'Sail trim UI' });
    const a = await asAgent(w, w.chomnr);
    const b = await asAgent(w, w.friend, 'codex');
    await w.services.tasks.claim(a, task.id);
    await expect(w.services.tasks.claim(b, task.id)).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('chomnr') });
    await expect(w.services.tasks.claim(b, task.id, { force: true })).rejects.toMatchObject({ code: 'invalid_input' });
    const { task: taken } = await w.services.tasks.claim(b, task.id, { force: true, reason: 'chomnr asked me to finish it' });
    expect(taken.ownerId).toBe('friend');
    const unread = await w.services.messages.unread(w.chomnr, ['sailing']);
    expect(unread.some((m) => m.type === 'handoff' && m.taskId === task.id)).toBe(true);
  });

  it('marks tasks stale when the owning agent goes offline', async () => {
    w = await world(kind);
    const task = await w.services.tasks.create(w.chomnr, { project: 'sailing', title: 'Hull decals' });
    const a = await asAgent(w, w.chomnr);
    await w.services.tasks.claim(a, task.id);
    expect((await w.services.tasks.get(w.chomnr, task.id)).stale).toBe(false);
    w.clock.advance(20 * MINUTE);
    expect((await w.services.tasks.get(w.chomnr, task.id)).stale).toBe(true);
  });

  it('completes a task, releases its reservations and frees the agent', async () => {
    w = await world(kind);
    const task = await w.services.tasks.create(w.chomnr, { project: 'sailing', title: 'Ocean shader' });
    const a = await asAgent(w, w.chomnr);
    await w.services.tasks.claim(a, task.id);
    await w.services.reservations.reserve(a, { project: 'sailing', paths: ['Assets/Shaders/Ocean.shader'], reason: 'shader', taskId: task.id });
    expect(await w.services.reservations.list(a, 'sailing')).toHaveLength(1);
    const done = await w.services.tasks.complete(a, task.id, { summary: 'Depth-aware foam', commitSha: 'abcdef123' });
    expect(done.status).toBe('done');
    expect(done.completionSummary).toContain('abcdef1');
    expect(await w.services.reservations.list(a, 'sailing')).toHaveLength(0);
    expect((await w.services.agents.get(a.agentId!)).currentTaskId).toBeNull();
  });

  it('rejects stale writes with expectedVersion (optimistic concurrency)', async () => {
    w = await world(kind);
    const task = await w.services.tasks.create(w.chomnr, { project: 'sailing', title: 'Docs' });
    await w.services.tasks.update(w.chomnr, task.id, { description: 'first', expectedVersion: 1 });
    await expect(w.services.tasks.update(w.friend, task.id, { description: 'second', expectedVersion: 1 })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('warns when claiming a task whose dependencies are not done', async () => {
    w = await world(kind);
    const first = await w.services.tasks.create(w.chomnr, { project: 'sailing', title: 'Ocean system' });
    const second = await w.services.tasks.create(w.chomnr, { project: 'sailing', title: 'Boats float', dependsOn: [first.id] });
    const { warnings } = await w.services.tasks.claim(w.friend, second.id);
    expect(warnings[0]).toContain(`#${first.id}`);
  });
});
