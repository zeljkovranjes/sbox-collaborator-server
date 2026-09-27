import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyGithubSignature } from '../src/services/webhooks.js';
import { asAgent, DB_KINDS, world, type World } from './helpers.js';

const sign = (body: string) => `sha256=${createHmac('sha256', 'webhook-secret').update(body).digest('hex')}`;

function push(overrides: Partial<{ ref: string; sender: string; commits: unknown[] }> = {}) {
  return {
    ref: overrides.ref ?? 'refs/heads/feat/buoyancy',
    before: '0'.repeat(40),
    after: 'b'.repeat(40),
    created: false,
    deleted: false,
    forced: false,
    repository: { full_name: 'chomnr/sailing', default_branch: 'main' },
    sender: { login: overrides.sender ?? 'chomnr' },
    commits: overrides.commits ?? [
      {
        id: 'a'.repeat(40),
        message: '#1 Rewrite buoyancy',
        timestamp: '2026-09-01T12:00:00Z',
        url: 'https://github.com/chomnr/sailing/commit/aaaa',
        author: { name: 'chomnr', username: 'chomnr' },
        added: ['Code/Ocean/Buoyancy.cs'],
        modified: ['Code/BoatController.cs', 'Assets/Ships/Ship.vmdl'],
        removed: [],
      },
    ],
  };
}

describe('webhook signatures', () => {
  it('accepts only the exact HMAC of the raw body', () => {
    const body = JSON.stringify({ hello: 'world' });
    expect(verifyGithubSignature('webhook-secret', Buffer.from(body), sign(body))).toBe(true);
    expect(verifyGithubSignature('webhook-secret', Buffer.from(`${body} `), sign(body))).toBe(false);
    expect(verifyGithubSignature('other', Buffer.from(body), sign(body))).toBe(false);
    expect(verifyGithubSignature('webhook-secret', Buffer.from(body), undefined)).toBe(false);
  });
});

describe.each(DB_KINDS)('GitHub webhook processing (%s)', (kind) => {
  let w: World;
  afterEach(() => w?.close());

  it('stores pushes and correlates developer, task, agent and assets', async () => {
    w = await world(kind);
    const task = await w.services.tasks.create(w.chomnr, { project: 'sailing', title: 'Buoyancy' });
    const a = await asAgent(w, w.chomnr);
    await w.services.tasks.claim(a, task.id, { branch: 'feat/buoyancy' });
    const events: string[] = [];
    w.services.deps.bus.subscribe((e) => events.push(e.type));

    const result = await w.services.webhooks.handle('push', 'delivery-1', push());
    expect(result.status).toBe('processed');
    const [commit] = await w.services.git.recentCommits(w.friend, 'sailing');
    expect(commit).toMatchObject({ developerId: 'chomnr', taskId: task.id, branch: 'feat/buoyancy' });
    const stored = await w.services.deps.db.selectFrom('commits').select('agentId').executeTakeFirstOrThrow();
    expect(stored.agentId).toBe(a.agentId);
    expect(events).toContain('commit_detected');
    const assets = await w.services.assets.recentChanges(w.friend, 'sailing');
    expect(assets.map((x) => x.path)).toContain('Assets/Ships/Ship.vmdl');
    const feed = await w.services.activity.recent('sailing', { limit: 3 });
    expect(feed.some((f) => f.summary.includes('committed aaaaaaa'))).toBe(true);
  });

  it('ignores duplicate deliveries and unknown repositories', async () => {
    w = await world(kind);
    await w.services.webhooks.handle('push', 'delivery-2', push());
    expect((await w.services.webhooks.handle('push', 'delivery-2', push())).status).toBe('duplicate');
    const foreign = { ...push(), repository: { full_name: 'someone/else', default_branch: 'main' } };
    expect((await w.services.webhooks.handle('push', 'delivery-3', foreign)).status).toBe('ignored');
    expect(await w.services.git.recentCommits(w.friend, 'sailing')).toHaveLength(1);
  });

  it('warns the reservation owner when someone pushes to their reserved files', async () => {
    w = await world(kind);
    const a = await asAgent(w, w.chomnr);
    await w.services.reservations.reserve(a, { project: 'sailing', paths: ['Code/'], reason: 'refactor' });
    await w.services.webhooks.handle('push', 'delivery-4', push({ sender: 'friendgh', commits: [{ ...push().commits[0], author: { name: 'Friend', username: 'friendgh' } }] }));
    const unread = await w.services.messages.unread(w.chomnr, ['sailing']);
    expect(unread.some((m) => m.type === 'warning' && m.body.includes('reserved'))).toBe(true);
    const critical = await w.services.activity.recent('sailing', { minImportance: 3 });
    expect(critical[0]!.summary).toContain('reserved by chomnr');
  });

  it('tracks pull requests and finishes linked review tasks on merge', async () => {
    w = await world(kind);
    const task = await w.services.tasks.create(w.chomnr, { project: 'sailing', title: 'Sails' });
    await w.services.tasks.claim(w.chomnr, task.id, { branch: 'feat/sails' });
    await w.services.tasks.complete(w.chomnr, task.id, { summary: 'ready', status: 'review' });
    const pr = { number: 7, title: `Sails (#${task.id})`, state: 'closed', html_url: 'https://github.com/chomnr/sailing/pull/7', user: { login: 'chomnr' }, head: { ref: 'feat/sails' }, base: { ref: 'main' }, merged_at: '2026-09-01T12:00:00Z', updated_at: '2026-09-01T12:00:00Z' };
    await w.services.webhooks.handle('pull_request', 'delivery-5', { action: 'closed', pull_request: pr, repository: { full_name: 'chomnr/sailing' }, sender: { login: 'chomnr' } });
    const after = await w.services.tasks.get(w.chomnr, task.id);
    expect(after.status).toBe('done');
    expect(after.githubPr).toBe(7);
  });
});
