// The usage bar for a session that runs on another PC: that PC's own usage and limits (`GET /pclink/usage`, Watch level), never mixed
// with this PC's. The rows have the shape of this PC's own usage bar, so the bar draws them the same way. Their sign-in keys are
// namespaced by the device so pace history and chip keys of the two PCs cannot meet. The last good answer is kept per device (in
// memory and in this browser's storage), so an offline PC reads "last known 2 h ago" instead of nothing.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PcLinkClient } from './pclink';
import { pollWithBackoff } from './pollWithBackoff';
import type { UsageRow, UsageSnapshot } from '../usage';

const STORE_KEY = 'pm.farUsage.v1';
/** How often the numbers are read again while the bar shows that PC. */
export const FAR_USAGE_POLL_MS = 60_000;

interface Kept {
  snap: UsageSnapshot;
  /** When this PC got it (ms). */
  at: number;
}

const memory = new Map<string, Kept>();

function readStore(): Record<string, Kept> {
  try {
    const v: unknown = JSON.parse(window.localStorage.getItem(STORE_KEY) ?? '{}');
    return v && typeof v === 'object' ? (v as Record<string, Kept>) : {};
  } catch {
    return {};
  }
}

function writeStore(node: string, kept: Kept): void {
  try {
    const all = readStore();
    all[node] = kept;
    window.localStorage.setItem(STORE_KEY, JSON.stringify(all));
  } catch {
    /* the last numbers are simply not remembered across restarts */
  }
}

/** The last good numbers of a device: from this run, else from storage. */
export function keptUsage(node: string): Kept | null {
  const mine = memory.get(node);
  if (mine) return mine;
  const stored = readStore()[node];
  if (stored && Array.isArray(stored.snap?.rows) && typeof stored.at === 'number') {
    memory.set(node, stored);
    return stored;
  }
  return null;
}

/** The far PC's rows with sign-in keys of their own (`far:<node>:...`): they never share a key, a pace history or a chip with this PC's rows. */
export function namespaced(node: string, snap: UsageSnapshot): UsageSnapshot {
  const rows: UsageRow[] = snap.rows
    .filter((r) => !r.link)
    .map((r) => ({ ...r, account_id: `far:${node}:${r.account_id ?? ''}`, page: null, same_as_main: false }));
  return { rows, refreshed_at_ms: snap.refreshed_at_ms };
}

/** "2h" to "2 h", "9h 55m" to "9 h 55 m": the time in a chip's hover line. */
export function spacedUnits(text: string): string {
  return text.replace(/(\d)([a-z])/g, '$1 $2');
}

export interface FarUsage {
  snap: UsageSnapshot | null;
  busy: boolean;
  refresh: () => Promise<void>;
  /** The PC did not answer: when its numbers were last read (ms), or null when it did answer (or never did and nothing is kept). */
  staleSince: number | null;
  /** It has not answered and nothing is kept. */
  none: boolean;
}

/** Reads a device's usage now, then every minute, while `active`. A failed read keeps the last good numbers and says how old they are. */
export function useFarUsage(client: PcLinkClient | null, active: boolean): FarUsage {
  const node = client?.node ?? null;
  const [state, setState] = useState<{ node: string | null; snap: UsageSnapshot | null; staleSince: number | null; none: boolean }>({ node: null, snap: null, staleSince: null, none: false });
  const [busy, setBusy] = useState(false);
  const live = useRef(true);
  const read = useCallback(async () => {
    if (!client) return;
    try {
      const snap = await client.usage();
      const kept = { snap, at: Date.now() };
      memory.set(client.node, kept);
      writeStore(client.node, kept);
      if (live.current) setState({ node: client.node, snap: namespaced(client.node, snap), staleSince: null, none: false });
    } catch (error) {
      const kept = keptUsage(client.node);
      if (live.current) setState({ node: client.node, snap: kept ? namespaced(client.node, kept.snap) : null, staleSince: kept ? kept.at : null, none: !kept });
      throw error;
    }
  }, [client]);
  useEffect(() => {
    live.current = true;
    if (!client || !active) return undefined;
    // What is kept shows at once (marked old) until the first answer.
    const kept = keptUsage(client.node);
    if (kept) setState({ node: client.node, snap: namespaced(client.node, kept.snap), staleSince: kept.at, none: false });
    const stop = pollWithBackoff({ node: client.node, route: 'usage', normalMs: FAR_USAGE_POLL_MS, run: read });
    return () => {
      live.current = false;
      stop();
    };
  }, [client, active, read]);
  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      await read().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }, [read]);
  const mine = state.node === node ? state : { node, snap: null, staleSince: null, none: false };
  return { snap: mine.snap, busy, refresh, staleSince: mine.staleSince, none: mine.none };
}

/** Forgets what this run kept in memory (tests; the stored copy is the storage's own). */
export function forgetFarUsageInMemory(): void {
  memory.clear();
}
