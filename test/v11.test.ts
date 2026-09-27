import { afterEach, describe, expect, it } from 'vitest';
import { SecretBox } from '../src/lib/crypto.js';
import { branchFor } from '../src/services/tasks.js';
import { asAgent, DB_KINDS, MINUTE, world, type World } from './helpers.js';

const DAY = 24 * 60 * MINUTE;

function push(files: { added?: string[]; modified?: string[] }, sha = 'c'.repeat(40), author = 'friendgh') {
  return {
    ref: 'refs/heads/main',
    before: '0'.repeat(40),
    after: sha,
    created: false,
    deleted: false,
    forced: false,
    repository: { full_name: 'chomnr/sailing', default_branch: 'main' },
    sender: { login: author },
    commits: [{ id: sha, message: 'Tune storm particles', timestamp: '2026-09-01T12:00:00Z', url: `https://github.com/chomnr/sailing/commit/${sha}`, author: { name: author, username: author }, added: files.added ?? [], modified: files.modified ?? [], removed: [] }],
  };
}

describe('small helpers', () => {
  it('suggests readable branches', () => {
    expect(branchFor(42, 'Sailing physics: buoyancy rewrite!')).toBe('task/42-sailing-physics-buoyancy-rewrite');
    expect(branchFor(7, '???')).toBe('task/7');
  });

  it('encrypts secrets and rejects tampering or the wrong key', () => {
    const box = new SecretBox('k'.repeat(40), 'discord-webhook');
    const sealed = box.seal('https://discord.com/api/webhooks/1/abc');
    expect(sealed).not.toContain('discord.com');
    expect(box.open(sealed)).toBe('https://discord.com/api/webhooks/1/abc');
    expect(new SecretBox('x'.repeat(40), 'discord-webhook').open(sealed)).toBeNull();
    expect(box.open(`${sealed.slice(0, -3)}AAA`)).toBeNull();
  });
});

describe.each(DB_KINDS)('handoffs (%s)', (kind) => {
  let w: World;
  afterEach(() => w?.close());

  it('hands a task to a teammate with a note, releasing reservations and messaging them', async () => {
    w = await world(kind);
    const a = await asAgent(w, w.chomnr);
    const task = await w.services.tasks.create(a, { project: 'sailing', title: 'Buoyancy rewrite' });
    await w.services.tasks.claim(a, task.id);
    await w.services.reservations.reserve(a, { project: 'sailing', paths: ['Code/Ocean/'], reason: 'rewrite', taskId: task.id });
    const handed = await w.services.tasks.handoff(a, task.id, { summary: 'Forces done, damping missing', next: 'Add angular damping', gotchas: 'Test in ocean_test.scene', to: 'friend' });
    expect(handed).toMatchObject({ status: 'claimed', ownerId: 'friend', agentId: null });
    expect(handed.lastHandoff).toMatchObject({ summary: 'Forces done, damping missing', next: 'Add angular damping', authorName: 'chomnr', toDeveloperId: 'friend' });
    expect(handed.suggestedBranch).toBe(`task/${task.id}-buoyancy-rewrite`);
    expect(handed.stale).toBe(false); // waiting for the new owner, not abandoned
    expect(await w.services.reservations.list(a, 'sailing')).toHaveLength(0);
    const unread = await w.services.messages.unread(w.friend, ['sailing'], { markRead: false });
    expect(unread.find((m) => m.type === 'handoff')?.body).toContain('Forces done');
    expect((await w.services.tasks.notes(task.id))[0]!.gotchas).toBe('Test in ocean_test.scene');
    const b = await asAgent(w, w.friend, 'codex');
    const text = w.services.sync.renderContext(await w.services.sync.context(b, 'sailing'));
    expect(text).toContain('handoff from chomnr: Forces done, damping missing');
    expect(text).toContain(`branch: task/${task.id}-buoyancy-rewrite`);
  });

  it('puts a task back on the board without a recipient and refuses strangers', async () => {
    w = await world(kind);
    const task = await w.services.tasks.create(w.chomnr, { project: 'sailing', title: 'Sails' });
    await w.services.tasks.claim(w.chomnr, task.id);
    await expect(w.services.tasks.handoff(w.friend, task.id, { summary: 'mine now' })).rejects.toMatchObject({ code: 'forbidden' });
    const back = await w.services.tasks.handoff(w.chomnr, task.id, { summary: 'Out of time' });
    expect(back).toMatchObject({ status: 'available', ownerId: null });
  });
});

describe.each(DB_KINDS)('catch-up, digests, history (%s)', (kind) => {
  let w: World;
  afterEach(() => w?.close());

  it('catches you up on teammates’ work and what needs you, then only on new things', async () => {
    w = await world(kind);
    await w.services.summary.catchUp(w.chomnr, 'sailing'); // sets the marker
    w.clock.advance(MINUTE);
    const b = await asAgent(w, w.friend, 'codex');
    const done = await w.services.tasks.create(b, { project: 'sailing', title: 'Storm weather' });
    await w.services.tasks.claim(b, done.id);
    await w.services.tasks.complete(b, done.id, { summary: 'Storms work' });
    const mine = await w.services.tasks.create(b, { project: 'sailing', title: 'Rain audio' });
    await w.services.tasks.claim(b, mine.id);
    await w.services.tasks.handoff(b, mine.id, { summary: 'Loop is set up', to: 'chomnr' });
    await w.services.changes.complete(b, { project: 'sailing', summary: 'Weather API rewrite', apisRemoved: ['SetRain()'], breakingChanges: ['Use WeatherSystem.Set'] });
    await w.services.decisions.create(b, { project: 'sailing', title: 'One WeatherSystem', context: 'c', decision: 'd', reasoning: 'r' });
    await w.services.webhooks.handle('push', 'd1', push({ modified: ['Code/Weather.cs'] }));
    w.clock.advance(MINUTE);

    const up = await w.services.summary.catchUp(w.chomnr, 'sailing');
    expect(up.counts).toMatchObject({ commits: 1, tasksCompleted: 1, breaking: 1, decisions: 1 });
    expect(up.summary).toContain('### Needs you');
    expect(up.summary).toContain('Handed to you');
    expect(up.summary).not.toContain('handoff from'); // the handoff message is not repeated
    expect(up.summary).toContain('-SetRain()');
    expect(up.summary).toContain('#1 Storm weather');
    expect(up.summary).toContain('1 commit on main');
    // Your own work is not news to you.
    const theirs = await w.services.summary.catchUp(w.friend, 'sailing', w.clock.now() - DAY);
    expect(theirs.counts.tasksCompleted).toBe(0);
    w.clock.advance(MINUTE);
    const again = await w.services.summary.catchUp(w.chomnr, 'sailing');
    expect(again.counts.commits).toBe(0);
  });

  it('writes one weekly digest per slot and announces it', async () => {
    w = await world(kind, { DIGEST_WEEKDAY: '1', DIGEST_HOUR: '9' });
    const events: string[] = [];
    w.services.deps.bus.subscribe((e) => events.push(e.type));
    await w.services.webhooks.handle('push', 'd2', push({ modified: ['Code/Boat.cs'] }));
    expect(await w.services.summary.weeklyDigests()).toBe(1);
    expect(await w.services.summary.weeklyDigests()).toBe(0);
    expect(events).toContain('digest_created');
    const [digest] = await w.services.summary.listDigests(w.chomnr, 'sailing');
    expect(digest!.stats.commits).toBe(1);
    expect(digest!.summary).toContain('Sailing');
    w.clock.advance(7 * DAY);
    expect(await w.services.summary.weeklyDigests()).toBe(1);
  });

  it('shows who touched a file or folder', async () => {
    w = await world(kind);
    await w.services.webhooks.handle('push', 'd3', push({ added: ['Assets/Weather/storm.vmat'], modified: ['Code/Weather.cs'] }));
    await w.services.changes.complete(w.friend, { project: 'sailing', summary: 'Storm material', files: ['Assets/Weather/storm.vmat'], breakingChanges: ['old rain.vmat removed'] });
    await w.services.tasks.create(w.friend, { project: 'sailing', title: 'Lightning', relatedFiles: ['Assets/Weather/'] });
    const b = await asAgent(w, w.friend, 'codex');
    await w.services.reservations.reserve(b, { project: 'sailing', paths: ['Assets/Weather/'], reason: 'storms' });

    const file = await w.services.summary.history(w.chomnr, 'sailing', 'assets/weather/storm.vmat');
    expect(file.commits[0]).toMatchObject({ shortSha: 'ccccccc', change: 'added', author: 'Friend' });
    expect(file.changes[0]).toMatchObject({ summary: 'Storm material', breaking: true });
    expect(file.reservations[0]!.path).toBe('Assets/Weather/');
    const folder = await w.services.summary.history(w.chomnr, 'sailing', 'Assets/Weather/');
    expect(folder.commits).toHaveLength(1);
    expect(folder.tasks.map((t) => t.title)).toEqual(['Lightning']);
    const other = await w.services.summary.history(w.chomnr, 'sailing', 'Code/Boat.cs');
    expect(other.commits).toHaveLength(0);
  });
});

describe.each(DB_KINDS)('Discord notifications (%s)', (kind) => {
  let w: World;
  afterEach(() => {
    w?.services.discord.stop();
    return w?.close();
  });

  it('pings for blockers, broken builds, handoffs and direct messages, with mentions; nothing else', async () => {
    const posts: { url: string; content: string }[] = [];
    let first429 = true;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      if (first429) {
        first429 = false;
        return new Response(JSON.stringify({ retry_after: 0.01 }), { status: 429 });
      }
      posts.push({ url, content: JSON.parse(String(init.body)).content });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    w = await world(kind, {});
    // Rebuild the notifier with the fake transport.
    const { DiscordNotifier } = await import('../src/services/notifications.js');
    const notifier = new DiscordNotifier(w.services.deps, w.services.directory, w.services.projects, fakeFetch);
    notifier.start();

    await expect(w.services.projects.update(w.chomnr, 'sailing', { discordWebhookUrl: 'https://evil.example.com/hook' })).rejects.toMatchObject({ code: 'invalid_input' });
    const project = await w.services.projects.update(w.chomnr, 'sailing', { discordWebhookUrl: 'https://discord.com/api/webhooks/123/abc-DEF' });
    expect(project.discordConfigured).toBe(true);
    expect(JSON.stringify(project)).not.toContain('abc-DEF');
    await w.services.accounts.updateDeveloper('friend', { discordUserId: '123456789012345678' });
    await expect(w.services.accounts.updateDeveloper('friend', { discordUserId: 'nope' })).rejects.toMatchObject({ code: 'invalid_input' });

    const a = await asAgent(w, w.chomnr);
    const task = await w.services.tasks.create(a, { project: 'sailing', title: 'Rudder' });
    await w.services.tasks.claim(a, task.id); // not pinged
    await w.services.tasks.block(a, task.id, 'waiting for the boat API');
    await w.services.tests.result(a, { project: 'sailing', description: 'storm test', status: 'failed', commitSha: 'abcdef1234', branch: 'main' });
    await w.services.tasks.handoff(a, task.id, { summary: 'Hinge done', to: 'friend' });
    await w.services.messages.send(a, { project: 'sailing', to: 'friend', type: 'question', body: 'Is OceanSystem thread safe?' });
    await w.services.messages.send(a, { project: 'sailing', type: 'info', body: 'broadcast info' }); // not pinged
    await notifier.idle();
    notifier.stop();

    const text = posts.map((p) => p.content).join('\n---\n');
    expect(posts.every((p) => p.url === 'https://discord.com/api/webhooks/123/abc-DEF')).toBe(true);
    expect(text).toContain('🛑');
    expect(text).toContain('waiting for the boat API');
    expect(text).toContain('❌');
    expect(text).toContain('🤝');
    expect(text).toContain('<@123456789012345678>');
    expect(text).toContain('Is OceanSystem thread safe?');
    expect(text).not.toContain('broadcast info');
    expect(text).not.toContain('claimed');
  });
});
