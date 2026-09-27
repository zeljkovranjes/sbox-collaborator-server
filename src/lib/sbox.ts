/** s&box file types the server understands. */
export const ASSET_TYPES = [
  'code',
  'style',
  'shader',
  'model',
  'compiled',
  'material',
  'texture',
  'sound',
  'scene',
  'prefab',
  'map',
  'animgraph',
  'source_model',
  'image',
  'audio',
  'particle',
  'other',
] as const;
export type AssetType = (typeof ASSET_TYPES)[number];

const BY_EXTENSION: Record<string, AssetType> = {
  cs: 'code',
  razor: 'code',
  scss: 'style',
  shader: 'shader',
  shdrgrph: 'shader',
  shdrfunc: 'shader',
  vmdl: 'model',
  vmat: 'material',
  vtex: 'texture',
  vsnd: 'sound',
  sound: 'sound',
  sndscape: 'sound',
  scene: 'scene',
  prefab: 'prefab',
  vmap: 'map',
  animgraph: 'animgraph',
  vanmgrph: 'animgraph',
  fbx: 'source_model',
  glb: 'source_model',
  gltf: 'source_model',
  obj: 'source_model',
  dmx: 'source_model',
  smd: 'source_model',
  png: 'image',
  tga: 'image',
  jpg: 'image',
  jpeg: 'image',
  psd: 'image',
  exr: 'image',
  hdr: 'image',
  wav: 'audio',
  mp3: 'audio',
  ogg: 'audio',
  vpcf: 'particle',
};

export function extensionOf(path: string): string {
  const name = path.replace(/\/$/, '').split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function assetTypeOf(path: string): AssetType {
  const ext = extensionOf(path);
  if (ext.length > 2 && ext.endsWith('_c')) return 'compiled';
  return BY_EXTENSION[ext] ?? 'other';
}

/** Whether a changed file is worth tracking as an asset (everything s&box knows about). */
export const isTrackedAsset = (path: string) => assetTypeOf(path) !== 'other';

export const nameOf = (path: string) => path.replace(/\/$/, '').split('/').pop() ?? path;

const REFERENCE =
  /["']([^"'\r\n]{1,300}?\.(?:vmdl|vmat|vtex|vsnd|sound|scene|prefab|vmap|animgraph|vanmgrph|shader|shdrgrph|vpcf|fbx|glb|gltf|obj|dmx|smd|png|tga|jpg|jpeg|psd|exr|hdr|wav|mp3|ogg)(?:_c)?)["']/gi;

/**
 * Pulls asset paths out of a text asset (.vmdl, .vmat, .prefab, .scene, .sound, ...).
 * s&box stores references as quoted, project-relative paths inside KV3/JSON.
 */
export function extractReferences(content: string): string[] {
  const found = new Set<string>();
  for (const match of content.matchAll(REFERENCE)) {
    const raw = match[1]!.replace(/\\/g, '/').trim();
    if (/^[a-z]+:\/\//i.test(raw)) continue;
    found.add(raw.replace(/^\/+/, ''));
  }
  return [...found];
}
