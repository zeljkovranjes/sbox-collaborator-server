import type { ComponentChildren } from 'preact';
import { createContext } from 'preact';
import { useCallback, useContext, useEffect, useRef, useState } from 'preact/hooks';
import { api, ApiError } from './api';

// ---------------------------------------------------------------- formatting

export function ago(iso: string | null | undefined): string {
  if (!iso) return '';
  const diff = Date.now() - Date.parse(iso);
  if (diff < 45_000) return 'just now';
  if (diff < 3_600_000) return `${Math.max(1, Math.round(diff / 60_000))}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.round(diff / 86_400_000)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function until(iso: string): string {
  const diff = Date.parse(iso) - Date.now();
  if (diff <= 0) return 'expired';
  if (diff < 3_600_000) return `${Math.ceil(diff / 60_000)}m left`;
  return `${Math.round(diff / 3_600_000)}h left`;
}

export const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

export function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

// ---------------------------------------------------------------- data hooks

/** Loads data, and reloads when `deps` change or a realtime event bumps the refresh counter. */
export function useLoad<T>(loader: () => Promise<T>, deps: unknown[]): { data: T | undefined; error: string | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const refresh = useContext(RefreshContext);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    loader()
      .then((value) => alive && (setData(value), setError(null)))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce, refresh]);
  return { data, error, loading, reload: useCallback(() => setNonce((n) => n + 1), []) };
}

export const RefreshContext = createContext(0);

/** Subscribes to the project's SSE stream; bumps a debounced counter that makes pages refetch. */
export function useRealtime(project: string | null, onEvent?: (type: string, data: any) => void): { tick: number; live: boolean } {
  const [tick, setTick] = useState(0);
  const [live, setLive] = useState(false);
  const handler = useRef(onEvent);
  handler.current = onEvent;
  useEffect(() => {
    if (!project) return;
    const source = new EventSource(`/api/events?project=${encodeURIComponent(project)}`);
    let timer: number | undefined;
    const bump = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setTick((t) => t + 1), 350);
    };
    source.onopen = () => setLive(true);
    source.onerror = () => setLive(false);
    const types = ['agent_registered', 'agent_status_changed', 'agent_offline', 'task_created', 'task_claimed', 'task_updated', 'task_completed', 'file_reserved', 'file_released', 'reservation_expired', 'change_started', 'change_completed', 'change_abandoned', 'message_received', 'commit_detected', 'branch_updated', 'pull_request_updated', 'issue_updated', 'decision_created', 'decision_superseded', 'knowledge_added', 'test_started', 'test_result', 'build_broken', 'asset_changed', 'project_updated'];
    for (const type of types) {
      source.addEventListener(type, (event) => {
        bump();
        try {
          handler.current?.(type, JSON.parse((event as MessageEvent).data).data);
        } catch {
          /* ignore */
        }
      });
    }
    return () => {
      window.clearTimeout(timer);
      source.close();
      setLive(false);
    };
  }, [project]);
  return { tick, live };
}

// ---------------------------------------------------------------- toasts

type Toast = { id: number; kind: 'ok' | 'error' | 'info'; text: string };
const ToastContext = createContext<(kind: Toast['kind'], text: string) => void>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastHost({ children }: { children: ComponentChildren }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((all) => [...all.slice(-3), { id, kind, text }]);
    window.setTimeout(() => setToasts((all) => all.filter((t) => t.id !== id)), kind === 'error' ? 7000 : 3500);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div class="toasts">
        {toasts.map((t) => (
          <div key={t.id} class={`toast ${t.kind}`}>
            <Icon name={t.kind === 'error' ? 'error' : t.kind === 'ok' ? 'check_circle' : 'info'} fill />
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** Runs an API action with toast feedback. */
export function useAction() {
  const toast = useToast();
  return useCallback(
    async <T,>(work: () => Promise<T>, success?: string): Promise<T | undefined> => {
      try {
        const result = await work();
        if (success) toast('ok', success);
        return result;
      } catch (e) {
        toast('error', e instanceof ApiError ? e.message : 'Something went wrong');
        return undefined;
      }
    },
    [toast],
  );
}

// ---------------------------------------------------------------- small components

export const Icon = ({ name, fill, class: cls, style }: { name: string; fill?: boolean; class?: string; style?: string }) => (
  <span class={`icon${fill ? ' fill' : ''}${cls ? ` ${cls}` : ''}`} style={style} aria-hidden="true">
    {name}
  </span>
);

const AVATAR_COLORS = ['#b0e24d', '#e6db74', '#df9194', '#7fa8f5', '#ff9800', '#8fd6c8', '#c7a4f0'];
export function colorFor(id: string): string {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]!;
}

export function Avatar({ id, name, githubLogin, status, size, title }: { id: string; name: string; githubLogin?: string | null; status?: string; size?: 'sm' | 'lg'; title?: string }) {
  const initials = name
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
  return (
    <span class={`avatar${size ? ` ${size}` : ''}${status === 'offline' ? ' offline' : ''}`} data-status={status} style={`background:${colorFor(id)}`} title={title ?? name}>
      {githubLogin ? <img src={`https://avatars.githubusercontent.com/${githubLogin}?s=80`} alt="" onError={(e) => ((e.currentTarget as HTMLImageElement).style.display = 'none')} /> : initials}
    </span>
  );
}

const STATUS_PILL: Record<string, string> = {
  working: 'green', in_progress: 'green', done: 'green', passed: 'green', accepted: 'green',
  planning: 'yellow', testing: 'yellow', reviewing: 'yellow', review: 'yellow', claimed: 'blue', running: 'blue', proposed: 'blue',
  blocked: 'red', failed: 'red', error: 'red', urgent: 'red',
  high: 'orange', warning: 'yellow', blocker: 'red', handoff: 'blue', request: 'blue', question: 'blue',
};
export const Pill = ({ value, label }: { value: string; label?: string }) => <span class={`pill ${STATUS_PILL[value] ?? ''}`}>{label ?? value.replace(/_/g, ' ')}</span>;

export const Eyebrow = ({ icon, title, aside }: { icon?: string; title: string; aside?: ComponentChildren }) => (
  <div class="eyebrow">
    {icon && <Icon name={icon} />}
    <span>{title}</span>
    {aside !== undefined && <span class="aside">{aside}</span>}
  </div>
);

export const Empty = ({ icon, text }: { icon: string; text: string }) => (
  <div class="empty">
    <Icon name={icon} />
    {text}
  </div>
);

export function Modal({ title, icon, onClose, children, footer, wide }: { title: string; icon?: string; onClose: () => void; children: ComponentChildren; footer?: ComponentChildren; wide?: boolean }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  return (
    <div class="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true">
        <div class="modal-head">
          {icon && <Icon name={icon} class="green" />}
          <h2 class="grow">{title}</h2>
          <button class="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>
        <div class="modal-body">{children}</div>
        {footer && <div class="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Loading() {
  return (
    <div class="loading">
      <div class="spinner" />
    </div>
  );
}

export function Secret({ value }: { value: string }) {
  const toast = useToast();
  return (
    <div class="secret">
      <div class="codebox">{value}</div>
      <button
        class="btn"
        onClick={() => {
          void navigator.clipboard.writeText(value);
          toast('ok', 'Copied');
        }}
      >
        <Icon name="content_copy" /> Copy
      </button>
    </div>
  );
}

export { api };
