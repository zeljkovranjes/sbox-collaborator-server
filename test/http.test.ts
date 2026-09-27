import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/http/app.js';
import { McpGateway } from '../src/mcp/server.js';
import { world, type World } from './helpers.js';

let w: World;
let server: Server;
let base: string;

beforeAll(async () => {
  w = await world('sqlite');
  const mcp = new McpGateway(w.services, 'test');
  server = createServer(createApp({ services: w.services, mcp, version: 'test', startedAt: Date.now() }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await w.close();
});

async function call(path: string, options: { token?: string; body?: unknown; method?: string; headers?: Record<string, string> } = {}) {
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? (options.body !== undefined ? 'POST' : 'GET'),
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: response.status, json, headers: response.headers };
}

describe('authentication', () => {
  it('serves health and public server info without a key', async () => {
    expect((await call('/healthz')).json.ok).toBe(true);
    expect((await call('/api/server-info')).json.result.name).toBe('Collaborator');
  });

  it('rejects missing, malformed and revoked keys', async () => {
    expect((await call('/api/me')).status).toBe(401);
    expect((await call('/api/me', { token: 'sbc_aaaaaaaaaaaa_notTheRightSecretAtAll123' })).status).toBe(401);
    const { token, key } = await w.services.accounts.createAccessKey('friend', { name: 'temp', via: 'test' });
    expect((await call('/api/me', { token })).json.result.developer.id).toBe('friend');
    await w.services.accounts.revokeAccessKey(w.friend, key.id);
    expect((await call('/api/me', { token })).status).toBe(401);
  });

  it('enforces read-only keys and project restrictions', async () => {
    await w.services.projects.create(null, { id: 'secret-lib', name: 'Secret', kind: 'library' });
    const readOnly = await w.services.accounts.createAccessKey('friend', { name: 'viewer', via: 'test', scopes: ['read'] });
    expect((await call('/api/tools/task_list', { token: readOnly.token, body: { project: 'sailing' } })).status).toBe(200);
    const denied = await call('/api/tools/task_create', { token: readOnly.token, body: { project: 'sailing', title: 'x' } });
    expect(denied.status).toBe(403);
    const scoped = await w.services.accounts.createAccessKey('friend', { name: 'sailing only', via: 'test', projectIds: ['sailing'] });
    expect((await call('/api/tools/task_list', { token: scoped.token, body: { project: 'secret-lib' } })).status).toBe(403);
    const projects = await call('/api/tools/project_list', { token: scoped.token, body: {} });
    expect(projects.json.result.map((p: { id: string }) => p.id)).toEqual(['sailing']);
  });

  it('validates tool arguments strictly', async () => {
    const response = await call('/api/tools/task_create', { token: w.chomnrToken, body: { project: 'sailing', titel: 'typo' } });
    expect(response.status).toBe(400);
    expect(response.json.error.code).toBe('invalid_input');
  });

  it('requires the CSRF header for cookie-authenticated writes', async () => {
    const login = await call('/api/auth/key-login', { body: { token: w.chomnrToken } });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    expect(login.headers.get('set-cookie')).toContain('HttpOnly');
    expect((await call('/api/me', { headers: { cookie } })).json.result.viaSession).toBe(true);
    expect((await call('/api/tools/task_create', { body: { project: 'sailing', title: 'x' }, headers: { cookie } })).status).toBe(403);
    expect((await call('/api/tools/task_create', { body: { project: 'sailing', title: 'x' }, headers: { cookie, 'x-collab-request': '1' } })).status).toBe(200);
  });
});

describe('joining with a server key and the device flow', () => {
  it('checks server keys and lets each be used once', async () => {
    const { token } = await w.services.accounts.createJoinKey({ name: 'for alex', githubLogin: 'alexgh' });
    expect((await call('/api/auth/server-key/check', { body: { serverKey: token } })).json.result.valid).toBe(true);
    expect((await call('/api/auth/server-key/check', { body: { serverKey: 'sbj_000000000000_wrongwrongwrongwrong' } })).json.error.code).toBe('invalid_server_key');
    const key = (await w.services.accounts.checkJoinKey(token))!;
    await expect(w.services.accounts.developerForGithub({ id: 99, login: 'mallory', name: null }, key.id)).rejects.toMatchObject({ code: 'invalid_server_key' });
    const alex = await w.services.accounts.developerForGithub({ id: 42, login: 'alexgh', name: 'Alex' }, key.id);
    expect(alex.displayName).toBe('Alex');
    expect(await w.services.accounts.checkJoinKey(token)).toBeNull();
    // Existing developers sign in again without a key.
    expect((await w.services.accounts.developerForGithub({ id: 42, login: 'alexgh', name: 'Alex' }, null)).id).toBe(alex.id);
    await expect(w.services.accounts.developerForGithub({ id: 7, login: 'stranger', name: null }, null)).rejects.toMatchObject({ code: 'invalid_server_key' });
  });

  it('hands the editor an access key once the browser approves', async () => {
    expect((await call('/api/auth/device', { body: { clientName: 'editor', clientType: 'sbox-editor', serverKey: 'sbj_000000000000_wrongwrongwrongwrong' } })).status).toBe(401);
    const started = (await call('/api/auth/device', { body: { clientName: 's&box editor on DESK', clientType: 'sbox-editor' } })).json.result;
    expect(started.verificationUriComplete).toContain(started.userCode);
    const pending = await call('/api/auth/device/token', { body: { deviceCode: started.deviceCode } });
    expect(pending.status).toBe(428);
    expect(pending.json.error.code).toBe('authorization_pending');
    await w.services.device.approve(started.userCode, 'friend');
    const granted = await call('/api/auth/device/token', { body: { deviceCode: started.deviceCode } });
    expect(granted.status).toBe(200);
    expect(granted.json.result.developer.id).toBe('friend');
    expect((await call('/api/me', { token: granted.json.result.token })).json.result.developer.id).toBe('friend');
    expect((await call('/api/auth/device/token', { body: { deviceCode: started.deviceCode } })).status).toBe(410);
  });
});

describe('MCP transport', () => {
  it('initialises, lists tools and runs the team workflow over Streamable HTTP', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${w.friendToken}` } } });
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(transport);
    expect(client.getInstructions()).toContain('project_sync_context');
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThanOrEqual(60);
    const registered = await client.callTool({ name: 'agent_register', arguments: { project: 'sailing', clientType: 'codex', machine: 'LAPTOP' } });
    expect(JSON.parse((registered.content as { text: string }[])[0]!.text).clientType).toBe('codex');
    const reserve = await client.callTool({ name: 'file_reserve', arguments: { paths: ['Assets/Weather/'], reason: 'storms' } });
    expect((reserve.content as { text: string }[])[0]!.text).toContain('Assets/Weather/');
    const reservation = await w.services.reservations.list(w.chomnr, 'sailing', { path: 'Assets/Weather/storm.vpcf' });
    expect(reservation[0]!.agentLabel).toBe('friend/codex@LAPTOP'); // the session remembered its agent
    const sync = await client.callTool({ name: 'project_sync_context', arguments: { focus: 'weather' } });
    expect((sync.content as { text: string }[])[0]!.text).toContain('# Sailing');
    const bad = await client.callTool({ name: 'task_get', arguments: { taskId: 999 } });
    expect(bad.isError).toBe(true);
    await client.close();
  });

  it('refuses MCP without a valid key and offers a core profile', async () => {
    expect((await call('/mcp', { body: {} })).status).toBe(401);
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp?profile=core`), { requestInit: { headers: { authorization: `Bearer ${w.chomnrToken}` } } });
    const client = new Client({ name: 'cursor', version: '1' });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.length).toBeLessThanOrEqual(40);
    await client.close();
  });
});

describe('webhook endpoint', () => {
  it('rejects bad signatures and processes signed deliveries', async () => {
    const body = JSON.stringify({ zen: 'hi', hook_id: 1 });
    const bad = await fetch(`${base}/webhooks/github`, { method: 'POST', headers: { 'x-github-event': 'ping', 'x-hub-signature-256': 'sha256=00', 'content-type': 'application/json' }, body });
    expect(bad.status).toBe(401);
    const signature = `sha256=${createHmac('sha256', 'webhook-secret').update(body).digest('hex')}`;
    const good = await fetch(`${base}/webhooks/github`, { method: 'POST', headers: { 'x-github-event': 'ping', 'x-github-delivery': 'ping-1', 'x-hub-signature-256': signature, 'content-type': 'application/json' }, body });
    expect(good.status).toBe(200);
  });
});
