import { useState } from 'preact/hooks';
import { api, type Asset, type Project } from '../api';
import { ago, Empty, Eyebrow, Icon, Loading, useLoad } from '../lib';
import { HistoryPanel } from '../summary';

const TYPES = ['', 'code', 'shader', 'model', 'material', 'texture', 'sound', 'scene', 'prefab', 'map', 'animgraph', 'source_model', 'image', 'audio', 'particle', 'style', 'compiled'];
const TYPE_ICON: Record<string, string> = {
  code: 'code', style: 'palette', shader: 'gradient', model: 'deployed_code', compiled: 'inventory', material: 'texture', texture: 'image', sound: 'graphic_eq', scene: 'landscape', prefab: 'widgets', map: 'map', animgraph: 'account_tree', source_model: 'view_in_ar', image: 'image', audio: 'music_note', particle: 'auto_awesome', other: 'draft',
};

interface TreeNode {
  path: string;
  type: string;
  known: boolean;
  repeated?: boolean;
  children?: TreeNode[];
}
interface AssetDetail {
  asset: Asset & { known?: boolean };
  dependencies: { path: string; type: string }[];
  references: { path: string; type: string }[];
  reservedBy: { developer: string; agent: string | null; path: string; taskId: number | null; reason: string; expiresAt: string }[];
}

function Tree({ node }: { node: TreeNode }) {
  return (
    <li>
      <span class={node.known ? '' : 'faint'}>
        <Icon name={TYPE_ICON[node.type] ?? 'draft'} style="font-size:14px;vertical-align:-2px;margin-right:4px" class="muted" />
        {node.path}
        {node.repeated && <span class="faint"> ↺</span>}
      </span>
      {node.children && node.children.length > 0 && (
        <ul>
          {node.children.map((c) => (
            <Tree node={c} key={c.path} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function AssetsPage({ project }: { project: Project }) {
  const [query, setQuery] = useState('');
  const [type, setType] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<'search' | 'recent'>('search');
  const assets = useLoad(
    () => (view === 'recent' ? api.tool<Asset[]>('asset_recent_changes', { project: project.id, limit: 60 }) : api.tool<Asset[]>('asset_search', { project: project.id, limit: 120, ...(query ? { query } : {}), ...(type ? { type } : {}) })),
    [project.id, query, type, view],
  );
  const detail = useLoad(() => (selected ? api.tool<AssetDetail>('asset_get', { project: project.id, path: selected }) : Promise.resolve(null)), [selected]);
  const deps = useLoad(() => (selected ? api.tool<TreeNode>('asset_find_dependencies', { project: project.id, path: selected, depth: 4 }) : Promise.resolve(null)), [selected]);
  const refs = useLoad(() => (selected ? api.tool<TreeNode>('asset_find_references', { project: project.id, path: selected, depth: 3 }) : Promise.resolve(null)), [selected]);

  return (
    <>
      <div class="page-head">
        <div class="grow">
          <h1>s&amp;box assets</h1>
          <p>Models, materials, textures, shaders, sounds, scenes and their relationships (from the editor scan, pushes and agents).</p>
        </div>
        <div class="seg">
          <button class={view === 'search' ? 'on' : ''} onClick={() => setView('search')}>
            Browse
          </button>
          <button class={view === 'recent' ? 'on' : ''} onClick={() => setView('recent')}>
            Recently changed
          </button>
        </div>
      </div>
      <div class="split">
        <div class="panel">
          {view === 'search' && (
            <div class="panel-body row" style="border-bottom:1px solid var(--line)">
              <div class="search grow">
                <Icon name="search" />
                <input class="input" placeholder="Ship, ocean, citizen…" value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
              </div>
              <select class="select" style="width:160px" value={type} onChange={(e) => setType((e.target as HTMLSelectElement).value)}>
                {TYPES.map((t) => (
                  <option value={t} key={t}>
                    {t ? t.replace('_', ' ') : 'All types'}
                  </option>
                ))}
              </select>
            </div>
          )}
          {!assets.data ? (
            <Loading />
          ) : assets.data.length === 0 ? (
            <Empty icon="deployed_code" text="No assets yet. Open the project in s&box with the Collaborator library, or push to GitHub." />
          ) : (
            <div>
              {assets.data.map((a) => (
                <div class={`list-row click`} key={a.path} onClick={() => setSelected(a.path)} style={selected === a.path ? 'background:#2b2b2b' : ''}>
                  <Icon name={TYPE_ICON[a.type] ?? 'draft'} />
                  <div class="grow">
                    <div class="ellipsis" style="font-weight:500">{a.name}</div>
                    <div class="mono tiny faint ellipsis">{a.path}</div>
                  </div>
                  <span class="pill ghost">{a.type.replace('_', ' ')}</span>
                  {a.lastChangedAt && <span class="tiny muted nowrap">{ago(a.lastChangedAt)}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
        <div class="panel">
          {!selected ? (
            <Empty icon="account_tree" text="Select an asset to see what it uses and what uses it." />
          ) : !detail.data ? (
            <Loading />
          ) : (
            <>
              <div class="panel-body">
                <div class="row">
                  <Icon name={TYPE_ICON[detail.data.asset.type] ?? 'draft'} class="green" />
                  <b class="grow ellipsis">{detail.data.asset.name}</b>
                </div>
                <div class="mono tiny faint" style="margin-top:4px">
                  {detail.data.asset.path}
                </div>
                {detail.data.asset.description && <p class="prose small">{detail.data.asset.description}</p>}
                {'lastChangedByName' in detail.data.asset && detail.data.asset.lastChangedByName && (
                  <div class="small muted" style="margin-top:6px">
                    Last changed by {detail.data.asset.lastChangedByName} {ago(detail.data.asset.lastChangedAt)}
                    {detail.data.asset.lastCommitSha ? ` in ${detail.data.asset.lastCommitSha.slice(0, 7)}` : ''}
                  </div>
                )}
                {detail.data.reservedBy.map((r) => (
                  <div class="banner yellow" style="margin-top:10px" key={r.path}>
                    <Icon name="lock" />
                    <span class="small" style="color:var(--text)">
                      Reserved by <b>{r.developer}</b> ({r.path}){r.taskId ? ` for #${r.taskId}` : ''}: {r.reason}
                    </span>
                  </div>
                ))}
              </div>
              <Eyebrow icon="south" title="Uses" />
              <div class="panel-body tree">{deps.data?.children?.length ? <ul>{deps.data.children.map((c) => <Tree node={c} key={c.path} />)}</ul> : <span class="faint">No known dependencies.</span>}</div>
              <Eyebrow icon="north" title="Used by" />
              <div class="panel-body tree">{refs.data?.children?.length ? <ul>{refs.data.children.map((c) => <Tree node={c} key={c.path} />)}</ul> : <span class="faint">Nothing references this asset.</span>}</div>
              <Eyebrow icon="history" title="History" />
              <div class="panel-body">
                <HistoryPanel project={project} initial={selected} key={selected} />
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
