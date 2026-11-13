// Keeps the "Continue where you left off" snapshot (yesterday-memory.ts) current: written when the open chats or the
// split change, and again when the window goes away. Nothing is written before the cockpit is ready, so the start
// does not wipe the snapshot it is about to offer.
import { useEffect, useRef } from 'react';
import type { PaneInfo } from '../../lib/tauri-types';
import type { SplitMemory } from './split-memory';
import { previousRun, snapshotNow, writeYesterday } from './yesterday-memory';

export function useYesterdaySnapshot({ ready, panes, split }: { ready: boolean; panes: readonly PaneInfo[]; split: SplitMemory | null }): void {
  // Capture the last run before this run writes anything (this render runs before the first effect below).
  previousRun();
  const latest = useRef({ panes, split });
  latest.current = { panes, split };
  const lastText = useRef<string | null>(null);

  useEffect(() => {
    if (!ready) return;
    const snap = snapshotNow(panes, split, Date.now());
    const text = JSON.stringify({ chats: snap.chats, split: snap.split });
    if (text === lastText.current) return;
    lastText.current = text;
    writeYesterday(snap);
  }, [ready, panes, split]);

  useEffect(() => {
    if (!ready) return;
    const onHide = () => {
      const { panes: now, split: nowSplit } = latest.current;
      writeYesterday(snapshotNow(now, nowSplit, Date.now()));
    };
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, [ready]);
}
