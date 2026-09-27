import { afterEach, describe, expect, it } from 'vitest';
import { asAgent, DB_KINDS, MINUTE, world, type World } from './helpers.js';

describe.each(DB_KINDS)('agent presence (%s)', (kind) => {
  let w: World;
  afterEach(() => w?.close());

  it('goes offline without heartbeats and comes back on the next call', async () => {
    w = await world(kind);
    const a = await asAgent(w, w.chomnr);
    expect(await w.services.agents.listActive(w.friend, 'sailing')).toHaveLength(1);
    w.clock.advance(16 * MINUTE);
    expect(await w.services.agents.listActive(w.friend, 'sailing')).toHaveLength(0);
    expect(await w.services.agents.sweepOffline()).toBe(1);
    expect((await w.services.agents.get(a.agentId!)).status).toBe('offline');
    await w.services.agents.touch(a.agentId!);
    const back = await w.services.agents.get(a.agentId!);
    expect(back.online).toBe(true);
    expect(back.status).toBe('idle');
  });

  it('reuses the same agent on reconnect so task and reservations carry over', async () => {
    w = await world(kind);
    const first = await w.services.agents.register(w.chomnr, { project: 'sailing', clientType: 'claude-code', machine: 'DESK' });
    w.clock.advance(20 * MINUTE);
    const second = await w.services.agents.register(w.chomnr, { project: 'sailing', clientType: 'claude-code', machine: 'DESK' });
    expect(second.id).toBe(first.id);
    const other = await w.services.agents.register(w.chomnr, { project: 'sailing', clientType: 'claude-code', machine: 'LAPTOP' });
    expect(other.id).not.toBe(first.id);
  });

  it('publishes status changes to the activity feed and the event bus', async () => {
    w = await world(kind);
    const events: string[] = [];
    w.services.deps.bus.subscribe((e) => events.push(e.type));
    const a = await asAgent(w, w.chomnr);
    await w.services.agents.setStatus(a, a.agentId!, { status: 'blocked', note: 'waiting on OceanSystem API' });
    expect(events).toContain('agent_status_changed');
    const feed = await w.services.activity.recent('sailing', { limit: 1 });
    expect(feed[0]!.summary).toContain('blocked');
    expect(feed[0]!.importance).toBe(2);
  });

  it('never lets one developer drive another developer’s agent', async () => {
    w = await world(kind);
    const a = await asAgent(w, w.chomnr);
    await expect(w.services.agents.setStatus(w.friend, a.agentId!, { status: 'idle' })).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe.each(DB_KINDS)('messages (%s)', (kind) => {
  let w: World;
  afterEach(() => w?.close());

  it('delivers direct messages only to the recipient, emits realtime events', async () => {
    w = await world(kind);
    const seen: { type: string; audience?: string[] }[] = [];
    w.services.deps.bus.subscribe((e) => seen.push({ type: e.type, ...(e.audience ? { audience: e.audience } : {}) }));
    const a = await asAgent(w, w.chomnr);
    const sent = await w.services.messages.send(a, { project: 'sailing', to: 'friend', type: 'warning', body: 'Avoid BoatController.cs until #1 is done.' });
    expect(sent.broadcast).toBe(false);
    const event = seen.find((e) => e.type === 'message_received');
    expect(event?.audience).toEqual(['friend', 'chomnr']);
    expect(await w.services.messages.unread(w.chomnr, ['sailing'])).toHaveLength(0);
    const unread = await w.services.messages.unread(w.friend, ['sailing']);
    expect(unread.map((m) => m.body)).toEqual(['Avoid BoatController.cs until #1 is done.']);
    // warnings are acknowledged when read
    expect(await w.services.messages.unread(w.friend, ['sailing'])).toHaveLength(0);
  });

  it('keeps questions and blockers until acknowledged', async () => {
    w = await world(kind);
    const q = await w.services.messages.send(w.chomnr, { project: 'sailing', to: 'friend', type: 'question', body: 'Is OceanSystem.SampleHeight thread safe?' });
    expect(await w.services.messages.unread(w.friend, ['sailing'])).toHaveLength(1);
    expect(await w.services.messages.unread(w.friend, ['sailing'])).toHaveLength(1);
    await w.services.messages.acknowledge(w.friend, [q.id]);
    expect(await w.services.messages.unread(w.friend, ['sailing'])).toHaveLength(0);
  });

  it('broadcasts reach everyone but the sender, and agent-addressed messages reach that agent', async () => {
    w = await world(kind);
    const b = await asAgent(w, w.friend, 'codex');
    await w.services.messages.send(w.chomnr, { project: 'sailing', type: 'info', body: 'main is green again' });
    await w.services.messages.send(w.chomnr, { project: 'sailing', to: b.agentId!, type: 'request', body: 'Please release Assets/Weather/' });
    expect((await w.services.messages.unread(b, ['sailing'], { markRead: false })).map((m) => m.type).sort()).toEqual(['info', 'request']);
    expect(await w.services.messages.unread(w.chomnr, ['sailing'])).toHaveLength(0);
  });

  it('rate-limits chatter and drops duplicates', async () => {
    w = await world(kind);
    const a = await asAgent(w, w.chomnr);
    const first = await w.services.messages.send(a, { project: 'sailing', to: 'friend', type: 'info', body: 'same' });
    const dup = await w.services.messages.send(a, { project: 'sailing', to: 'friend', type: 'info', body: 'same' });
    expect(dup.id).toBe(first.id);
    for (let i = 0; i < 4; i++) await w.services.messages.send(a, { project: 'sailing', to: 'friend', type: 'info', body: `note ${i}` });
    await expect(w.services.messages.send(a, { project: 'sailing', to: 'friend', type: 'info', body: 'one too many' })).rejects.toMatchObject({ code: 'rate_limited' });
    w.clock.advance(11 * MINUTE);
    await expect(w.services.messages.send(a, { project: 'sailing', to: 'friend', type: 'info', body: 'later' })).resolves.toBeTruthy();
  });

  it('surfaces unread messages and breaking changes as notices', async () => {
    w = await world(kind);
    const a = await asAgent(w, w.chomnr);
    const b = await asAgent(w, w.friend, 'codex');
    await w.services.changes.complete(a, { project: 'sailing', summary: 'Buoyancy rewrite', apisRemoved: ['AddWaterForce()'], apisAdded: ['ApplyBuoyancyForce()'], breakingChanges: ['migrate AddWaterForce callers'] });
    await w.services.messages.send(a, { project: 'sailing', to: 'friend', type: 'blocker', body: 'Need your Weather API first' });
    const notices = await w.services.sync.notices(b);
    expect(notices.join('\n')).toMatch(/unread message/);
    expect(notices.join('\n')).toMatch(/BREAKING/);
    expect(await w.services.sync.notices(b)).toEqual([]); // throttled / said once
  });
});
