import { useState } from 'preact/hooks';
import { api, type Project } from '../api';
import { Eyebrow, Icon, useAction } from '../lib';

export function ProjectPage({ project, reload }: { project: Project; reload: () => void }) {
  const [form, setForm] = useState({
    name: project.name,
    kind: project.kind,
    packageIdent: project.packageIdent ?? '',
    defaultBranch: project.defaultBranch,
    repos: project.repos.map((r) => r.fullName).join('\n'),
    milestone: project.milestone,
    summary: project.summary,
    conventions: project.conventions,
    structure: project.structure,
    dirs: project.importantDirs.map((d) => `${d.path} – ${d.description}`).join('\n'),
  });
  const [dirty, setDirty] = useState(false);
  const act = useAction();
  const set = (key: keyof typeof form) => (e: Event) => {
    setForm({ ...form, [key]: (e.target as HTMLInputElement).value });
    setDirty(true);
  };
  const save = async () => {
    const importantDirs = form.dirs
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [path, ...rest] = line.split(/\s+[–-]\s+/);
        return { path: path!.trim(), description: rest.join(' – ').trim() };
      });
    const ok = await act(
      () =>
        api.tool('project_update_context', {
          project: project.id,
          name: form.name,
          kind: form.kind,
          packageIdent: form.packageIdent,
          defaultBranch: form.defaultBranch,
          repos: form.repos.split('\n').map((r) => r.trim()).filter(Boolean),
          milestone: form.milestone,
          summary: form.summary,
          conventions: form.conventions,
          structure: form.structure,
          importantDirs,
        }),
      'Project context saved – every agent sees it on its next sync',
    );
    if (ok) {
      setDirty(false);
      reload();
    }
  };

  return (
    <>
      <div class="page-head">
        <div class="grow">
          <h1>Project context</h1>
          <p>What every agent reads first. Keep it short and true.</p>
        </div>
        <button class="btn primary" disabled={!dirty} onClick={save}>
          <Icon name="save" /> Save
        </button>
      </div>
      <div class="split">
        <div class="col" style="gap:16px">
          <div class="panel">
            <Eyebrow icon="architecture" title="Architecture summary" />
            <div class="panel-body">
              <textarea class="textarea" style="min-height:200px" value={form.summary} onInput={set('summary')} placeholder="Boats are networked prefabs owned by the driver. One OceanSystem component samples waves for everything…" />
            </div>
          </div>
          <div class="panel">
            <Eyebrow icon="rule" title="Conventions" />
            <div class="panel-body">
              <textarea class="textarea" style="min-height:160px" value={form.conventions} onInput={set('conventions')} placeholder={'- Components in Code/<System>/\n- [Sync] only on the owner\n- Assets under Assets/<Area>/'} />
            </div>
          </div>
          <div class="panel">
            <Eyebrow icon="folder_open" title="Important directories" aside="one per line: path – description" />
            <div class="panel-body">
              <textarea class="textarea mono" style="min-height:130px" value={form.dirs} onInput={set('dirs')} placeholder={'Code/Ocean/ – wave sampling and buoyancy\nAssets/Ships/ – ship models and materials'} />
            </div>
          </div>
          <div class="panel">
            <Eyebrow icon="account_tree" title="Project structure" />
            <div class="panel-body">
              <textarea class="textarea mono" style="min-height:120px" value={form.structure} onInput={set('structure')} />
            </div>
          </div>
        </div>
        <div class="panel">
          <Eyebrow icon="tune" title="Settings" />
          <div class="panel-body col" style="gap:14px">
            <div class="field">
              <label>Name</label>
              <input class="input" value={form.name} onInput={set('name')} />
            </div>
            <div class="field">
              <label>Current milestone</label>
              <input class="input" value={form.milestone} onInput={set('milestone')} placeholder="Playable sailing prototype" />
            </div>
            <div class="row" style="gap:12px">
              <div class="field grow">
                <label>Type</label>
                <select class="select" value={form.kind} onChange={set('kind')}>
                  <option value="game">game</option>
                  <option value="library">library</option>
                  <option value="tool">tool</option>
                </select>
              </div>
              <div class="field grow">
                <label>Default branch</label>
                <input class="input mono" value={form.defaultBranch} onInput={set('defaultBranch')} />
              </div>
            </div>
            <div class="field">
              <label>Package ident</label>
              <input class="input mono" value={form.packageIdent} onInput={set('packageIdent')} placeholder="myorg.sailing" />
            </div>
            <div class="field">
              <label>GitHub repositories</label>
              <textarea class="textarea mono" style="min-height:70px" value={form.repos} onInput={set('repos')} placeholder="owner/sailing" />
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
