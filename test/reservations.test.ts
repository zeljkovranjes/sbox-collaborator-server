import { afterEach, describe, expect, it } from 'vitest';
import { overlap, normalizePath, pathKey } from '../src/lib/paths.js';
import { asAgent, DB_KINDS, MINUTE, world, type World } from './helpers.js';

describe('path overlap', () => {
  it('normalises Windows paths and keeps directory markers', () => {
    expect(normalizePath('.\\Code\\BoatController.cs')).toBe('Code/BoatController.cs');
    expect(normalizePath('Assets/Ships/')).toBe('Assets/Ships/');
    expect(() => normalizePath('../secrets')).toThrow();
    expect(() => normalizePath('C:/Users/x.cs')).toThrow();
  });

  it('detects exact, inside and contains relations case-insensitively', () => {
    expect(overlap(pathKey('code/boatcontroller.cs'), pathKey('Code/BoatController.cs'))).toBe('exact');
    expect(overlap(pathKey('Assets/Ships/Ship.vmdl'), pathKey('Assets/Ships/'))).toBe('inside');
    expect(overlap(pathKey('Assets/'), pathKey('Assets/Ships/Ship.vmdl'))).toBe('contains');
    expect(overlap(pathKey('Assets/ShipsExtra/a.vmat'), pathKey('Assets/Ships/'))).toBeNull();
    expect(overlap(pathKey('Code/Boat.cs'), pathKey('Code/BoatController.cs'))).toBeNull();
  });
});

describe.each(DB_KINDS)('reservations (%s)', (kind) => {
  let w: World;
  afterEach(() => w?.close());

  it('refuses paths another developer holds, with owner and task in the warning', async () => {
    w = await world(kind);
    const a = await asAgent(w, w.chomnr);
    const b = await asAgent(w, w.friend, 'codex');
    const task = await w.services.tasks.create(w.chomnr, { project: 'sailing', title: 'Buoyancy' });
    await w.services.reservations.reserve(a, { project: 'sailing', paths: ['Code/Ocean/'], reason: 'rewrite', taskId: task.id });
    const result = await w.services.reservations.reserve(b, { project: 'sailing', paths: ['code/ocean/Buoyancy.cs', 'Assets/Weather/'], reason: 'weather' });
    expect(result.reserved.map((r) => r.path)).toEqual(['Assets/Weather/']);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.relation).toBe('inside');
    expect(result.message).toContain('chomnr');
    expect(result.message).toContain(`#${task.id}`);
    const check = await w.services.reservations.checkConflict(b, 'sailing', ['Code/Ocean/Buoyancy.cs']);
    expect(check.clear).toBe(false);
    expect(check.message).toMatch(/WARNING/);
  });

  it('allows a forced reservation but warns the owner', async () => {
    w = await world(kind);
    const a = await asAgent(w, w.chomnr);
    const b = await asAgent(w, w.friend, 'codex');
    await w.services.reservations.reserve(a, { project: 'sailing', paths: ['Code/BoatController.cs'], reason: 'mine' });
    const result = await w.services.reservations.reserve(b, { project: 'sailing', paths: ['Code/BoatController.cs'], reason: 'hotfix agreed on voice', force: true });
    expect(result.reserved).toHaveLength(1);
    const unread = await w.services.messages.unread(w.chomnr, ['sailing']);
    expect(unread.some((m) => m.type === 'warning' && m.body.includes('force-reserved'))).toBe(true);
  });

  it('renews instead of duplicating when the same agent reserves again', async () => {
    w = await world(kind);
    const a = await asAgent(w, w.chomnr);
    await w.services.reservations.reserve(a, { project: 'sailing', paths: ['Code/A.cs'], reason: 'one', ttlMinutes: 10 });
    w.clock.advance(5 * MINUTE);
    const again = await w.services.reservations.reserve(a, { project: 'sailing', paths: ['Code/A.cs'], reason: 'two', ttlMinutes: 60 });
    const list = await w.services.reservations.list(a, 'sailing');
    expect(list).toHaveLength(1);
    expect(list[0]!.reason).toBe('two');
    expect(again.reserved[0]!.id).toBe(list[0]!.id);
  });

  it('expires reservations after their TTL', async () => {
    w = await world(kind);
    const a = await asAgent(w, w.chomnr);
    await w.services.reservations.reserve(a, { project: 'sailing', paths: ['Code/A.cs'], reason: 'short', ttlMinutes: 5 });
    w.clock.advance(4 * MINUTE);
    await w.services.agents.touch(a.agentId!);
    expect(await w.services.reservations.list(a, 'sailing')).toHaveLength(1);
    w.clock.advance(2 * MINUTE);
    expect(await w.services.reservations.list(a, 'sailing')).toHaveLength(0);
    expect(await w.services.reservations.sweep()).toBe(1);
    const feed = await w.services.activity.recent('sailing', { limit: 5 });
    expect(feed[0]!.summary).toContain('expired');
  });

  it('drops reservations when the agent stops sending heartbeats', async () => {
    w = await world(kind);
    const a = await asAgent(w, w.chomnr);
    await w.services.reservations.reserve(a, { project: 'sailing', paths: ['Assets/Ships/'], reason: 'ships', ttlMinutes: 24 * 60 });
    w.clock.advance(30 * MINUTE); // offline (15m) but still within the grace period (45m)
    expect(await w.services.reservations.list(w.friend, 'sailing')).toHaveLength(1);
    w.clock.advance(31 * MINUTE); // 61 minutes without a heartbeat
    expect(await w.services.reservations.list(w.friend, 'sailing')).toHaveLength(0);
    expect(await w.services.reservations.sweep()).toBe(1);
  });

  it('keeps reservations alive while heartbeats continue', async () => {
    w = await world(kind);
    const a = await asAgent(w, w.chomnr);
    await w.services.reservations.reserve(a, { project: 'sailing', paths: ['Assets/Ships/'], reason: 'ships', ttlMinutes: 24 * 60 });
    for (let i = 0; i < 12; i++) {
      w.clock.advance(10 * MINUTE);
      await w.services.agents.touch(a.agentId!);
    }
    expect(await w.services.reservations.list(w.friend, 'sailing')).toHaveLength(1);
  });

  it('serialises concurrent reservations of the same path', async () => {
    w = await world(kind);
    const a = await asAgent(w, w.chomnr);
    const b = await asAgent(w, w.friend, 'codex');
    const [ra, rb] = await Promise.all([
      w.services.reservations.reserve(a, { project: 'sailing', paths: ['Code/Shared.cs'], reason: 'a' }),
      w.services.reservations.reserve(b, { project: 'sailing', paths: ['Code/Shared.cs'], reason: 'b' }),
    ]);
    expect(ra.reserved.length + rb.reserved.length).toBe(1);
    expect(ra.conflicts.length + rb.conflicts.length).toBe(1);
  });
});
