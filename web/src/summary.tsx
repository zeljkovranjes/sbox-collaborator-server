import { useState } from 'preact/hooks';
import { api, type FileHistory, type Project } from './api';
import { ago, Empty, Icon, Loading, Pill } from './lib';

/** Renders the server's compact markdown (bold header, ### sections, "- " bullets). */
export function SummaryText({ text }: { text: string }) {
  const blocks: preact.JSX.Element[] = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.trimEnd();
    if (!line) return;
    if (line.startsWith('### ')) blocks.push(<div class="eyebrow" style="padding:12px 0 4px" key={i}>{line.slice(4)}</div>);
    else if (line.startsWith('- ')) {
      const body = line.slice(2);
      const tone = /^(BLOCKED|FAILED|ERROR)|BREAKING/i.test(body) ? 'red' : /^Handed to you|^(question|request|handoff|blocker|warning) from/i.test(body) ? 'yellow' : '';
      blocks.push(
        <div class="row" style="align-items:flex-start;padding:2px 0" key={i}>
          <span class={`dot ${tone === 'red' ? 'red' : tone === 'yellow' ? 'yellow' : ''}`} style="margin-top:7px" />
          <span class="small" style="color:var(--text-2)">{body}</span>
        </div>,
      );
    } else if (/^\*\*.*\*\*$/.test(line)) blocks.push(<div style="font-weight:600" key={i}>{line.slice(2, -2)}</div>);
    else blocks.push(<div class="small muted" key={i}>{line}</div>);
  });
  return <div>{blocks}</div>;
}

/** Look up who touched a file or folder. */
export function HistoryPanel({ project, initial }: { project: Project; initial?: string }) {
  const [path, setPath] = useState(initial ?? '');
  const [data, setData] = useState<FileHistory | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = async (e?: Event) => {
    e?.preventDefault();
    if (!path.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setData(await api.tool<FileHistory>('file_history', { project: project.id, path: path.trim(), limit: 30 }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="col" style="gap:10px">
      <form class="row" onSubmit={load}>
        <input class="input mono grow" placeholder="Code/BoatController.cs or Assets/Ships/" value={path} onInput={(e) => setPath((e.target as HTMLInputElement).value)} />
        <button class="btn" disabled={busy || !path.trim()}>
          <Icon name="history" /> History
        </button>
      </form>
      {error && <div class="small red">{error}</div>}
      {busy && <Loading />}
      {data && !busy && (
        <div class="col" style="gap:4px">
          {data.reservations.map((r) => (
            <div class="banner yellow" key={r.id}>
              <Icon name="lock" />
              <span class="small" style="color:var(--text)">
                Reserved by <b>{r.developerName}</b> ({r.path}){r.taskId ? ` for #${r.taskId}` : ''}: {r.reason}
              </span>
            </div>
          ))}
          {data.tasks.map((t) => (
            <div class="row small" key={t.id}>
              <Icon name="task_alt" class="muted" style="font-size:16px" />
              <span class="grow">#{t.id} {t.title} {t.ownerName ? <span class="muted">– {t.ownerName}</span> : null}</span>
              <Pill value={t.status} />
            </div>
          ))}
          {data.changes.map((c) => (
            <div class="row small" key={c.id} style="align-items:flex-start">
              <Icon name={c.breaking ? 'warning' : 'published_with_changes'} class={c.breaking ? 'red' : 'green'} style="font-size:16px" />
              <span class="grow">
                {c.summary} <span class="muted">– {c.developerName}, {ago(c.completedAt)}</span>
              </span>
            </div>
          ))}
          {data.commits.map((c) => (
            <a class="list-row click" style="padding:6px 4px" href={c.url ?? '#'} target="_blank" rel="noreferrer" key={c.sha}>
              <span class="mono green">{c.shortSha}</span>
              <span class="grow ellipsis">{c.message}</span>
              <span class="pill ghost">{c.change}</span>
              <span class="tiny muted nowrap">
                {c.author} · {ago(c.at)}
              </span>
            </a>
          ))}
          {!data.commits.length && !data.changes.length && !data.tasks.length && !data.reservations.length && <Empty icon="history" text="Nobody has touched this yet (as far as the server knows)." />}
        </div>
      )}
    </div>
  );
}
