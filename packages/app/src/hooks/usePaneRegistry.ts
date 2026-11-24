import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PaneStreamManager } from '../terminal/pane-stream';
import { createOwnerReplayReader } from '../terminal/pane-replay';
import type { PaneDataListener, PaneDataSubscriber, PaneResizeListener } from '../terminal/types';
import type { Host } from '../lib/host/host';
import { farPaneIo, type PaneBytes, type PaneIo } from '../lib/host/farPanes';
import {
  tauri,
  type PaneInfo,
  type PaneStatusEvent,
  type TerminalSnapshotEvent,
} from '../lib/tauri';

export interface PaneData {
  info: PaneInfo;
  status: PaneInfo['status'];
}

export interface PaneRegistryApi {
  panes: Map<string, PaneData>;
  paneList: PaneData[];
  /** True after the first pane list fetch completes. */
  initialReady: boolean;
  spawnPane: (args: Parameters<typeof tauri.spawnPane>[0]) => Promise<string>;
  killPane: (paneId: string) => Promise<void>;
  replacePaneAgent: (paneId: string, agentType: string, cwd?: string) => Promise<string>;
  killAll: () => Promise<void>;
  writeInput: (paneId: string, text: string, appendNewline?: boolean) => Promise<void>;
  resize: (paneId: string, cols: number, rows: number) => Promise<void>;
  refresh: () => Promise<void>;
  subscribePaneData: PaneDataSubscriber;
}

/** A far terminal that lost output (the link was slow) is cleared and drawn again from the far screen: a full reset. */
const RESET = new Uint8Array([0x1b, 0x63]);
/** After a "lost output" note the far screen is read once more, a little later (the burst has mostly passed). */
const LAG_REDRAW_MS = 600;

const EMPTY: Map<string, PaneData> = new Map();

function sameInfo(a: PaneInfo, b: PaneInfo): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof PaneInfo>;
  for (const key of keys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

/**
 * The pane map for a fresh `list_panes` answer, reusing the previous `PaneData` object of every
 * pane that did not change (and the previous Map when nothing did). `pty://panes-changed` fires
 * for any pane or standby event, so most refreshes are identical to the last one: rebuilding every
 * object made the whole window (and anything keyed on a pane's identity) re-render for nothing.
 */
export function nextPaneMap(prev: Map<string, PaneData>, list: PaneInfo[]): Map<string, PaneData> {
  let changed = prev.size !== list.length;
  const next = new Map<string, PaneData>();
  for (const info of list) {
    const old = prev.get(info.id);
    if (old && old.status === info.status && sameInfo(old.info, info)) {
      next.set(info.id, old);
    } else {
      next.set(info.id, { info, status: info.status });
      changed = true;
    }
  }
  if (!changed) {
    // Same panes, same order? Then the previous Map is still the truth.
    const prevIds = [...prev.keys()];
    if (list.every((info, index) => info.id === prevIds[index])) return prev;
  }
  return next;
}

/** The newest `pty://status` event of a pane and when it arrived (`at`: a counter that grows with every event). */
type StatusEvent = { status: PaneInfo['status']; at: number };

/**
 * `list` with the status of every pane that a `pty://status` event changed AFTER the list was asked for. The
 * answer is a picture from some moment between the request and its arrival; an event that came in meanwhile can be
 * newer than that picture. Without this a pane that began working while the list was on its way (a helper started
 * and given its first message at once) was put back to its older status, or its event was dropped because the pane
 * was not in the map yet, and it stayed idle in the sidebar (and "done" in its parent's Chat) while it worked.
 */
export function withNewerStatuses(list: PaneInfo[], events: Map<string, StatusEvent>, askedAt: number): PaneInfo[] {
  return list.map((info) => {
    const event = events.get(info.id);
    return event && event.at > askedAt && event.status !== info.status ? { ...info, status: event.status } : info;
  });
}

/**
 * The pane registry of one place. With no `host` it is this PC's (the Tauri commands and events); with a far host it is that PC's
 * terminals, over the PC link (`farPaneIo`), and `TerminalViewport` draws them the same way.
 */
export function usePaneRegistry(host?: Host): PaneRegistryApi {
  const io: PaneIo = useMemo(() => (host ? farPaneIo(host) : tauri), [host]);
  // Mount replay for this window: the screen at the PTY's current size, not size-mixed raw history.
  const readOwnerReplay = useMemo(() => createOwnerReplayReader({ readScreen: io.readScreenReplay, readRaw: io.readRawBuffer, pendingResize: io.pendingResize }), [io]);
  // What each open terminal listens with, so a far one can be redrawn from the screen.
  const subs = useRef(new Map<string, { cb: PaneDataListener; onResize?: PaneResizeListener; off: () => void }>());
  const resyncRef = useRef((paneId: string) => void paneId);

  const [panes, setPanes] = useState<Map<string, PaneData>>(EMPTY);
  const [initialReady, setInitialReady] = useState(false);
  const panesRef = useRef(panes);
  panesRef.current = panes;

  const streamsRef = useRef<PaneStreamManager>(null as unknown as PaneStreamManager);
  streamsRef.current ??= new PaneStreamManager({ onGap: (paneId) => resyncRef.current(paneId) });
  const replacingRef = useRef<Set<string>>(new Set());
  const exitRefreshTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Refreshes overlap (a pane event fires one while another is in flight). Only the newest one may
  // write: a slower, older list would bring back a pane that just closed (a ghost sidebar row) or
  // hide one that just opened.
  const refreshSeq = useRef(0);
  // The newest status event of each pane, kept even for a pane not listed yet (see withNewerStatuses).
  const statusEvents = useRef(new Map<string, StatusEvent>());
  const eventClock = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++refreshSeq.current;
    const askedAt = eventClock.current;
    try {
      const list = await io.listPanes();
      if (seq !== refreshSeq.current) return;
      const events = statusEvents.current;
      const current = withNewerStatuses(list, events, askedAt);
      const listed = new Set(list.map((info) => info.id));
      for (const [id, event] of events) if (!listed.has(id) && event.at <= askedAt) events.delete(id);
      setPanes((prev) => nextPaneMap(prev, current));
    } catch (err) {
      console.error('[usePaneRegistry] refresh failed', err);
    } finally {
      if (seq === refreshSeq.current) setInitialReady(true);
    }
  }, [io]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    let disposed = false;
    let unsubSnapshot: (() => void) | undefined;
    let unsubData: (() => void) | undefined;
    let unsubStatus: (() => void) | undefined;
    let unsubExit: (() => void) | undefined;
    let unsubPanesChanged: (() => void) | undefined;
    let unsubResized: (() => void) | undefined;
    let unsubLag: (() => void) | undefined;
    let lagTimer: ReturnType<typeof setTimeout> | undefined;

    (async () => {
      // A far PC that is away refuses a listener: what was set up so far must still be undone when this effect is gone (no poll timer left behind).
      try {
      unsubPanesChanged = await io.onPanesChanged(() => {
        void refresh();
      });
      const ingestData = (e: PaneBytes) => {
        streamsRef.current.ingest(e.pane_id, e.data, e.offset);
      };
      unsubData = await io.onTerminalData(ingestData);
      unsubResized = await io.onPtyResized((e) => {
        streamsRef.current.ingestResize(e.pane_id, e.cols, e.rows, e.offset);
      });
      unsubLag = await io.onTerminalLag?.((paneId) => {
        // One redraw per burst: the far PC says so again while output keeps being dropped.
        lagTimer ??= setTimeout(() => {
          lagTimer = undefined;
          resyncRef.current(paneId);
        }, LAG_REDRAW_MS);
      });
      // A far PC's pane status and exit arrive with its pane list (polled), not as events.
      if (!host) {
        unsubSnapshot = await tauri.onTerminalSnapshot((e: TerminalSnapshotEvent) => {
          // Snapshot events are retained for MCP/debug consumers; xterm rendering
          // consumes raw terminal-data events instead.
          void e;
        });
        unsubStatus = await tauri.onPtyStatus((e: PaneStatusEvent) => {
          statusEvents.current.set(e.pane_id, { status: e.status as PaneInfo['status'], at: ++eventClock.current });
          setPanes((prev) => {
            const existing = prev.get(e.pane_id);
            if (!existing || existing.status === e.status) return prev;
            const next = new Map(prev);
            next.set(e.pane_id, { ...existing, status: e.status });
            return next;
          });
        });
        unsubExit = await tauri.onPtyExit((e) => {
          if (replacingRef.current.has(e.pane_id)) {
            return;
          }
          setPanes((prev) => {
            const next = new Map(prev);
            const existing = next.get(e.pane_id);
            if (existing) {
              next.set(e.pane_id, { ...existing, status: 'error' });
            }
            return next;
          });
          const pending = exitRefreshTimers.current.get(e.pane_id);
          if (pending) clearTimeout(pending);
          const timer = setTimeout(() => {
            exitRefreshTimers.current.delete(e.pane_id);
            if (!replacingRef.current.has(e.pane_id)) {
              void refresh();
            }
          }, 200);
          exitRefreshTimers.current.set(e.pane_id, timer);
        });
      }

      } catch (err) {
        console.warn('[usePaneRegistry] could not listen', err);
      }
      if (disposed) {
        unsubLag?.();
        unsubData?.();
        unsubResized?.();
        unsubSnapshot?.();
        unsubStatus?.();
        unsubExit?.();
        unsubPanesChanged?.();
      }
    })();

    return () => {
      disposed = true;
      clearTimeout(lagTimer);
      unsubLag?.();
      unsubData?.();
      unsubResized?.();
      unsubSnapshot?.();
      unsubStatus?.();
      unsubExit?.();
      unsubPanesChanged?.();
    };
  }, [refresh, io, host]);

  const spawnPane = useCallback(async (args: Parameters<typeof tauri.spawnPane>[0]) => {
    const id = await io.spawnPane(args);
    await refresh();
    return id;
  }, [refresh, io]);

  const killPane = useCallback(async (paneId: string) => {
    await io.killPane(paneId);
    streamsRef.current.delete(paneId);
    await refresh();
  }, [refresh, io]);

  const replacePaneAgent = useCallback(
    async (paneId: string, agentType: string, cwd?: string) => {
      const existing = panesRef.current.get(paneId);
      if (!existing) {
        throw new Error(`unknown pane: ${paneId}`);
      }
      const { cols, rows } = existing.info;
      const spawnCwd = cwd ?? existing.info.cwd;

      streamsRef.current.reset(paneId);

      const pendingExit = exitRefreshTimers.current.get(paneId);
      if (pendingExit) {
        clearTimeout(pendingExit);
        exitRefreshTimers.current.delete(paneId);
      }

      replacingRef.current.add(paneId);
      try {
        await io.killPane(paneId);
        const id = await io.spawnPane({
          agent_type: agentType,
          pane_id: paneId,
          cols,
          rows,
          cwd: spawnCwd,
        });
        await refresh();
        return id;
      } catch (err) {
        await refresh();
        throw err;
      } finally {
        setTimeout(() => {
          replacingRef.current.delete(paneId);
        }, 800);
      }
    },
    [refresh, io],
  );

  const killAll = useCallback(async () => {
    await io.killAllPanes();
    await refresh();
  }, [refresh, io]);

  const writeInput = useCallback(async (paneId: string, text: string, appendNewline = true) => {
    await io.writeInput(paneId, text, appendNewline);
  }, [io]);

  const resize = useCallback(async (paneId: string, cols: number, rows: number) => {
    await io.resize(paneId, cols, rows);
  }, [io]);

  const subscribePaneData = useCallback<PaneDataSubscriber>((paneId, cb, onResize) => {
    const entry = { cb, onResize, off: streamsRef.current.subscribe(paneId, cb, readOwnerReplay, onResize) };
    subs.current.set(paneId, entry);
    return () => {
      entry.off();
      if (subs.current.get(paneId) === entry) subs.current.delete(paneId);
    };
  }, [readOwnerReplay]);
  resyncRef.current = (paneId) => {
    const entry = subs.current.get(paneId);
    if (!entry) return;
    entry.off();
    entry.cb(RESET);
    entry.off = streamsRef.current.subscribe(paneId, entry.cb, readOwnerReplay, entry.onResize);
  };


  const paneList = useMemo(
    // Oldest first; chats made in the same moment (restored together) go by id (byte order, as the far PC sorts its own), so the list is the same after every restart.
    () => Array.from(panes.values()).sort((a, b) => a.info.created_at - b.info.created_at || (a.info.id < b.info.id ? -1 : a.info.id > b.info.id ? 1 : 0)),
    [panes],
  );

  return {
    panes,
    paneList,
    initialReady,
    spawnPane,
    killPane,
    replacePaneAgent,
    killAll,
    writeInput,
    resize,
    refresh,
    subscribePaneData,
  };
}
