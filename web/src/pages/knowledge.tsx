import { useState } from 'preact/hooks';
import { api, type Knowledge, type Project } from '../api';
import { ago, Empty, Icon, Loading, Modal, useAction, useLoad } from '../lib';

const TAGS = ['networking', 'physics', 'rendering', 'shader', 'animation', 'ui', 'audio', 'asset', 'sbox-api', 'bug', 'workaround'];

export function KnowledgePage({ project }: { project: Project }) {
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState<string | null>(null);
  const [editing, setEditing] = useState<Knowledge | 'new' | null>(null);
  const list = useLoad(() => api.tool<Knowledge[]>('knowledge_search', { project: project.id, limit: 50, ...(query ? { query } : {}), ...(tag ? { tags: [tag] } : {}) }), [project.id, query, tag]);
  return (
    <>
      <div class="page-head">
        <div class="grow">
          <h1>Team knowledge</h1>
          <p>Engine facts, gotchas and workarounds your agents learned – so nobody learns them twice.</p>
        </div>
        <div class="search" style="width:260px">
          <Icon name="search" />
          <input class="input" placeholder="Search knowledge" value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
        </div>
        <button class="btn primary" onClick={() => setEditing('new')}>
          <Icon name="add" /> Add
        </button>
      </div>
      <div class="row wrap" style="margin-bottom:16px">
        {TAGS.map((t) => (
          <button key={t} class={`pill ${tag === t ? 'green' : 'ghost'}`} style="cursor:pointer;border-width:1px" onClick={() => setTag(tag === t ? null : t)}>
            #{t}
          </button>
        ))}
      </div>
      {!list.data ? (
        <Loading />
      ) : list.data.length === 0 ? (
        <div class="panel">
          <Empty icon="menu_book" text="Nothing yet. Agents add knowledge with knowledge_add." />
        </div>
      ) : (
        <div style="columns:360px;column-gap:14px">
          {list.data.map((k) => (
            <div class="panel card" style="break-inside:avoid;margin:0 0 14px;padding:14px 16px;background:var(--panel)" key={k.id} onClick={() => setEditing(k)}>
              <div class="row">
                <Icon name={k.tags.includes('workaround') ? 'build' : k.tags.includes('bug') ? 'bug_report' : 'lightbulb'} class="green" />
                <b class="grow">{k.title}</b>
                {!k.projectId && <span class="pill blue">global</span>}
              </div>
              <div class="prose small" style="margin-top:8px">
                {k.body}
              </div>
              <div class="row wrap" style="margin-top:10px">
                {k.tags.map((t) => (
                  <span class="chip" key={t}>
                    #{t}
                  </span>
                ))}
                <span class="spacer" />
                <span class="tiny faint">
                  {k.authorName} · {ago(k.updatedAt)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
      {editing && <EditKnowledge project={project} item={editing === 'new' ? null : editing} onClose={() => (setEditing(null), list.reload())} />}
    </>
  );
}

function EditKnowledge({ project, item, onClose }: { project: Project; item: Knowledge | null; onClose: () => void }) {
  const [title, setTitle] = useState(item?.title ?? '');
  const [body, setBody] = useState(item?.body ?? '');
  const [tags, setTags] = useState(item?.tags.join(', ') ?? '');
  const [global, setGlobal] = useState(item ? !item.projectId : false);
  const act = useAction();
  const tagList = () => tags.split(',').map((t) => t.trim()).filter(Boolean);
  const save = async () => {
    const ok = item
      ? await act(() => api.tool('knowledge_update', { knowledgeId: item.id, title, body, tags: tagList() }), 'Saved')
      : await act(() => api.tool('knowledge_add', { ...(global ? {} : { project: project.id }), title, body, tags: tagList() }), 'Added');
    if (ok) onClose();
  };
  const archive = async () => {
    if (item && (await act(() => api.tool('knowledge_update', { knowledgeId: item.id, archived: true }), 'Archived'))) onClose();
  };
  return (
    <Modal
      title={item ? 'Edit knowledge' : 'Add knowledge'}
      icon="menu_book"
      onClose={onClose}
      footer={
        <>
          {item && (
            <button class="btn danger" onClick={archive} style="margin-right:auto">
              Archive
            </button>
          )}
          <button class="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button class="btn primary" disabled={!title.trim() || !body.trim()} onClick={save}>
            Save
          </button>
        </>
      }
    >
      <div class="field">
        <label>Title</label>
        <input class="input" value={title} onInput={(e) => setTitle((e.target as HTMLInputElement).value)} placeholder="Ocean shader expects depth texture enabled" autoFocus />
      </div>
      <div class="field">
        <label>Details</label>
        <textarea class="textarea" style="min-height:140px" value={body} onInput={(e) => setBody((e.target as HTMLTextAreaElement).value)} />
      </div>
      <div class="field">
        <label>Tags</label>
        <input class="input" value={tags} onInput={(e) => setTags((e.target as HTMLInputElement).value)} placeholder="shader, rendering" />
      </div>
      {!item && (
        <label class="row small muted" style="cursor:pointer">
          <input type="checkbox" checked={global} onChange={(e) => setGlobal((e.target as HTMLInputElement).checked)} /> Applies to all projects (global)
        </label>
      )}
    </Modal>
  );
}
