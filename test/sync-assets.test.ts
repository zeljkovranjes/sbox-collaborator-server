import { afterEach, describe, expect, it } from 'vitest';
import { assetTypeOf, extractReferences } from '../src/lib/sbox.js';
import { asAgent, DB_KINDS, world, type World } from './helpers.js';

describe('s&box asset types', () => {
  it('classifies common file types', () => {
    expect(assetTypeOf('Assets/Ships/Ship.vmdl')).toBe('model');
    expect(assetTypeOf('Assets/Ships/Ship.vmdl_c')).toBe('compiled');
    expect(assetTypeOf('Assets/Shaders/Ocean.shader')).toBe('shader');
    expect(assetTypeOf('Code/UI/Hud.razor')).toBe('code');
    expect(assetTypeOf('Assets/anim/citizen.animgraph')).toBe('animgraph');
    expect(assetTypeOf('README.md')).toBe('other');
  });

  it('extracts references from KV3/JSON assets', () => {
    const vmdl = `{ m_meshFile = "models/ship.fbx" m_material = "materials/ship.vmat" url = "https://x.com/a.png" }`;
    expect(extractReferences(vmdl)).toEqual(['models/ship.fbx', 'materials/ship.vmat']);
  });
});

describe.each(DB_KINDS)('assets and context sync (%s)', (kind) => {
  let w: World;
  afterEach(() => w?.close());

  it('builds dependency and reference trees', async () => {
    w = await world(kind);
    await w.services.assets.register(w.chomnr, 'sailing', { path: 'Assets/Ships/Ship.vmdl', content: '"Assets/Ships/Ship.fbx" "Assets/Ships/Ship.vmat"' });
    await w.services.assets.register(w.chomnr, 'sailing', { path: 'Assets/Ships/Ship.vmat', dependencies: ['Assets/Ships/ship_albedo.png', 'Assets/Ships/ship_normal.png'] });
    const tree = await w.services.assets.dependencies(w.friend, 'sailing', 'assets/ships/ship.vmdl', 3);
    const vmat = tree.children!.find((c) => c.path.endsWith('.vmat'))!;
    expect(vmat.children!.map((c) => c.path)).toEqual(expect.arrayContaining(['Assets/Ships/ship_albedo.png', 'Assets/Ships/ship_normal.png']));
    const refs = await w.services.assets.references(w.friend, 'sailing', 'Assets/Ships/ship_albedo.png', 3);
    expect(refs.children![0]!.path).toBe('Assets/Ships/Ship.vmat');
    expect(refs.children![0]!.children![0]!.path).toBe('Assets/Ships/Ship.vmdl');
    expect((await w.services.assets.search(w.friend, 'sailing', { query: 'ship', type: 'material' })).map((a) => a.path)).toEqual(['Assets/Ships/Ship.vmat']);
  });

  it('applies an editor full scan and retires assets that disappeared', async () => {
    w = await world(kind);
    await w.services.assets.bulk(w.chomnr, 'sailing', { fullScan: true, assets: [{ path: 'a/one.vmat' }, { path: 'a/two.vmat', dependencies: ['a/tex.png'] }] });
    const second = await w.services.assets.bulk(w.chomnr, 'sailing', { fullScan: true, assets: [{ path: 'a/two.vmat' }] });
    expect(second.removed).toBe(1);
    expect((await w.services.assets.search(w.chomnr, 'sailing', {})).map((a) => a.path)).toEqual(['a/two.vmat']);
  });

  it('puts teammates’ work, API changes, decisions and messages into the sync packet', async () => {
    w = await world(kind);
    const a = await asAgent(w, w.chomnr);
    const b = await asAgent(w, w.friend, 'codex');
    const task = await w.services.tasks.create(a, { project: 'sailing', title: 'Buoyancy rewrite' });
    await w.services.tasks.claim(a, task.id);
    await w.services.reservations.reserve(a, { project: 'sailing', paths: ['Code/Ocean/'], reason: 'rewrite', taskId: task.id });
    await w.services.changes.complete(a, { project: 'sailing', summary: 'Buoyancy rewrite', taskId: task.id, files: ['Code/Ocean/Buoyancy.cs'], apisRemoved: ['AddWaterForce()'], apisAdded: ['ApplyBuoyancyForce()'], breakingChanges: ['Boat components using AddWaterForce must migrate'] });
    await w.services.decisions.create(a, { project: 'sailing', title: 'One shared OceanSystem', context: 'perf', decision: 'Use one shared OceanSystem instead of per-boat water simulation', reasoning: 'cheaper', affectedSystems: ['ocean'] });
    await w.services.decisions.create(a, { project: 'sailing', title: 'Proximity voice', context: 'design', decision: 'Use proximity voice for respawn', reasoning: 'fun', affectedSystems: ['audio'] });
    await w.services.messages.send(a, { project: 'sailing', to: 'friend', type: 'warning', body: 'Avoid Code/Ocean/ until #1 is done' });
    await w.services.knowledge.add(a, { project: 'sailing', title: 'Ocean shader expects depth texture', body: 'Enable depth', tags: ['shader'] });

    const packet = await w.services.sync.context(b, 'sailing', { focus: 'ocean buoyancy physics', paths: ['Code/Ocean/Waves.cs'] });
    expect(packet.team[0]!.agent).toContain('chomnr');
    expect(packet.reservations.others[0]!.path).toBe('Code/Ocean/');
    expect(packet.changes.completed[0]!.apisRemoved).toEqual(['AddWaterForce()']);
    expect(packet.decisions.map((d) => d.title)).toEqual(['One shared OceanSystem']);
    expect(packet.unreadMessages).toHaveLength(1);
    const text = w.services.sync.renderContext(packet);
    expect(text).toContain('BREAKING: Boat components using AddWaterForce must migrate');
    expect(text).toContain('Code/Ocean/ → chomnr');
    expect(text.length).toBeLessThan(6000);
    // The next sync only reports what is new.
    const again = await w.services.sync.context(b, 'sailing', {});
    expect(Date.parse(again.since)).toBeGreaterThanOrEqual(Date.parse(packet.generatedAt));
  });

  it('flags a broken build to the whole team', async () => {
    w = await world(kind);
    const b = await asAgent(w, w.friend, 'codex');
    const events: string[] = [];
    w.services.deps.bus.subscribe((e) => events.push(e.type));
    await w.services.tests.result(b, { project: 'sailing', description: 'storm test', status: 'failed', commitSha: 'abcdef1234', branch: 'main', errors: ['NullReferenceException'] });
    expect(events).toContain('build_broken');
    const overview = await w.services.sync.overview(w.chomnr, 'sailing');
    expect(overview.blockers[0]!.title).toContain('main is failing');
    expect((await w.services.messages.unread(w.chomnr, ['sailing']))[0]!.body).toContain('abcdef1');
  });
});
