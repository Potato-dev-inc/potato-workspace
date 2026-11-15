// Small hooks for the What's new surfaces.
import { useEffect, useState } from 'react';
import { loadSettings } from '../lib/settings';
import type { Filter } from './catalog';

/** `prefers-reduced-motion: reduce`, live. With no matchMedia (tests, old shells) motion is allowed. */
export function usePrefersReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)';
  const read = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false);
  const [reduced, setReduced] = useState(read);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(query);
    const on = () => setReduced(mq.matches);
    on();
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return reduced;
}

/** The filter for the catalog: the desktop cards whose Labs switch (if any) is on. Before settings load, Labs cards are held back. */
export function useCatalogFilter(): Filter {
  const [settings, setSettings] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    let alive = true;
    loadSettings()
      .then((s) => alive && setSettings(s as unknown as Record<string, unknown>))
      .catch(() => alive && setSettings({}));
    return () => {
      alive = false;
    };
  }, []);
  return { platform: 'desktop', labOn: (key) => settings?.[key] === true };
}
