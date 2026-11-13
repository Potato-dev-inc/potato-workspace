// The order of a project's pane tabs after the person dragged them. Saved per project folder (by its key), as the
// pane ids in order. Tabs the order does not know yet (opened later) come first. Never throws.
import { useCallback, useEffect, useState } from 'react';

export const LS_PANE_TAB_ORDER = 'pm.paneTabs.order';
const MAX_PROJECTS = 100;
const MAX_TABS = 60;

type Orders = Record<string, string[]>;

export function readTabOrders(): Orders {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LS_PANE_TAB_ORDER) ?? 'null');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Orders = {};
    for (const [key, ids] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(ids)) out[key] = [...new Set(ids.filter((x): x is string => typeof x === 'string' && x !== ''))].slice(0, MAX_TABS);
    }
    return out;
  } catch {
    return {};
  }
}

function writeTabOrders(orders: Orders): void {
  try {
    const keys = Object.keys(orders).slice(-MAX_PROJECTS);
    localStorage.setItem(LS_PANE_TAB_ORDER, JSON.stringify(Object.fromEntries(keys.map((k) => [k, orders[k]]))));
  } catch {
    /* storage is off: the order lasts until the window closes */
  }
}

/** The saved tab order of one project and the way to change it; saved on every change. */
export function usePaneTabOrder(projectKey: string): { order: string[]; setOrder: (ids: string[]) => void } {
  const [orders, setOrders] = useState<Orders>(readTabOrders);
  useEffect(() => {
    const onStorage = (e: StorageEvent) => e.key === LS_PANE_TAB_ORDER && setOrders(readTabOrders());
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  const setOrder = useCallback(
    (ids: string[]) => {
      const next = { ...readTabOrders() };
      delete next[projectKey];
      next[projectKey] = ids.slice(0, MAX_TABS);
      writeTabOrders(next);
      setOrders(next);
    },
    [projectKey],
  );
  return { order: orders[projectKey] ?? [], setOrder };
}
