import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';

export function navigate(path: string) {
  if (location.pathname + location.search === path) return;
  history.pushState(null, '', path);
  window.dispatchEvent(new Event('popstate'));
}

export function usePath(): string {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const update = () => setPath(location.pathname);
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);
  return path;
}

export const Link = ({ href, class: cls, children, title }: { href: string; class?: string; children: ComponentChildren; title?: string }) => (
  <a
    href={href}
    class={cls}
    title={title}
    onClick={(e) => {
      if (e.metaKey || e.ctrlKey || e.button !== 0) return;
      e.preventDefault();
      navigate(href);
    }}
  >
    {children}
  </a>
);
