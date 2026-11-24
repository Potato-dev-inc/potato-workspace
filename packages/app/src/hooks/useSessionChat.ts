// Read-only chat of one terminal pane: opens the backend's session-file reader while `enabled`, merges the
// item batches for this pane, and closes the reader again on unmount or when disabled.
import { errorSentence } from '../lib/sayError';
import { useHost } from '../lib/host/context';
import type { Host } from '../lib/host/host';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { chatEarlier } from '../lib/chatMore';
import { clearChatTiming, finishChatOpen, markChat } from '../lib/chatTiming';
import { chatKept, chatStores, chatTuning } from './chatTuning';
import { useEarlier, type EarlierState } from './useEarlier';
import {
  closeSessionChat,
  groupTurns,
  mergeItems,
  onSessionChatItems,
  onSessionChatSource,
  onSessionChatStatus,
  openSessionChat,
  type ChatItem,
  type ChatSource,
  type ChatTurn,
  type GroupedChat,
  type OutputFile,
  type PlanItem,
  type SessionChatState,
  type UsageItem,
} from '../lib/sessionChat';

export type { SessionChatState };

export interface SessionChatHook {
  state: SessionChatState;
  /** Why the chat is unavailable (from the backend, or the error that stopped the open). */
  reason: string | null;
  /** While there is nothing to show: what the reader is waiting for (from the backend), else null. */
  waitingFor: string | null;
  /** Where the chat is read from, once known: `file`, or `screen` for an agent with no session file. */
  source: ChatSource | null;
  turns: ChatTurn[];
  model: string | null;
  cliVersion: string | null;
  usage: UsageItem | null;
  /** The agent's task list now; empty when it made none. */
  plan: PlanItem[];
  /** Files the agent's tool calls touched, in order of first touch. */
  outputs: OutputFile[];
  /** "Show earlier messages": the part of a long chat that is no longer held, read from the chat's journal on the PC. */
  earlier: EarlierState;
}

interface Status {
  state: SessionChatState;
  reason: string | null;
  waitingFor: string | null;
  source: ChatSource | null;
}

const LOADING: Status = { state: 'loading', reason: null, waitingFor: null, source: null };

/** The last transcript of each chat, kept in memory: a reopened chat (or one of a PC that is off) shows what it had at once instead of going empty. */
const FAR_KEPT_MAX = 5;
const farKept = chatKept as Map<string, { items: ChatItem[]; status: Status }>;
const keepFar = (key: string, items: ChatItem[], status: Status): void => {
  if (status.state !== 'ready' || items.length === 0) return;
  farKept.delete(key);
  farKept.set(key, { items, status });
  if (farKept.size > FAR_KEPT_MAX) farKept.delete(farKept.keys().next().value as string);
};

interface View {
  key: string;
  items: ChatItem[];
  status: Status;
}

/**
 * One reader per chat, shared by every view of it (the chat, the side rail, the done list, a task view): one open, one close, one
 * set of event handlers. The last view to leave lets go after a short grace, so a remount or a quick switch back asks nothing again.
 */
interface Store {
  key: string;
  farKey: string;
  view: View;
  refs: number;
  subs: Set<(v: View) => void>;
  stop: (() => void) | null;
  closeTimer: ReturnType<typeof setTimeout> | null;
}
const stores = chatStores as Map<string, Store>;
const hostIds = new WeakMap<object, number>();
let hostSeq = 0;
const hostId = (h: object): number => {
  let id = hostIds.get(h);
  if (id === undefined) hostIds.set(h, (id = ++hostSeq));
  return id;
};
let lastAcquire = 0;

function publish(store: Store, items: ChatItem[], status: Status, far: boolean): void {
  store.view = { key: store.key, items, status };
  keepFar(store.farKey, items, status);
  for (const fn of [...store.subs]) fn(store.view);
}

function acquire(paneId: string, host: Host): Store {
  const far = host.place.kind === 'pc' && host.can?.('session_chat_open') !== false;
  const farKey = `${host.place.kind === 'pc' ? host.place.node : ''}|${paneId}`;
  // A far host is made again when its level arrives (caps change); its `link` stays, so the chat is opened once.
  const key = `${farKey}#${hostId(host.link ?? host)}${host.ended ? 'e' : ''}`;
  const had = stores.get(key);
  if (had) {
    had.refs++;
    if (had.closeTimer) clearTimeout(had.closeTimer);
    had.closeTimer = null;
    return had;
  }
  const kept = farKept.get(farKey);
  const mine: Store = { key, farKey, view: { key, items: kept?.items ?? [], status: kept?.status ?? LOADING }, refs: 1, subs: new Set(), stop: null, closeTimer: null };
  stores.set(key, mine);
  if (host.ended) {
    // A far chat that ended: the transcript this PC kept stays; with none kept there is nothing to read.
    mine.view = { key, items: kept?.items ?? [], status: kept?.status ?? { state: 'unavailable', reason: null, waitingFor: null, source: null } };
    return mine;
  }
  const surface = `s-${Math.random().toString(36).slice(2, 10)}`;
  let live = true;
  let opened = false;
  let unlisten: Array<() => void> = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Timing marks are per open: the last open's are cleared, and only this open's first item batch (before the
  // snapshot lands) is marked. `opening` ends with the snapshot, so no mark is left behind after the open.
  let opening = true;
  const keep = (p: Promise<() => void>) =>
    p.then(
      (off) => (live ? unlisten.push(off) : off()),
      () => undefined,
    );
  const start = () => {
    timer = null;
    if (!live) return;
    opened = true;
    clearChatTiming();
    markChat('view:open');
    // Subscribe before opening, so no batch that arrives while the open is in flight is lost.
    void keep(
      onSessionChatItems((event) => {
        if (!live || event.paneId !== paneId) return;
        const batch = event.items ?? [];
        if (opening && batch.length > 0) {
          opening = false;
          markChat('view:items');
        }
        publish(mine, mergeItems(mine.view.items, batch, event.reset), mine.view.status, far);
      }, host),
    );
    void keep(
      onSessionChatStatus((event) => {
        if (!live || event.paneId !== paneId) return;
        publish(mine, mine.view.items, { ...mine.view.status, waitingFor: event.waitingFor }, far);
      }, host),
    );
    void keep(
      onSessionChatSource((event) => {
        if (!live || event.paneId !== paneId) return;
        const prev = mine.view.status;
        if (prev.state === 'ready') publish(mine, mine.view.items, { ...prev, source: event.source }, far);
      }, host),
    );
    openSessionChat(paneId, surface, host)
      .then((snapshot) => {
        if (!live) return;
        // A backend that answers with nothing must not crash the view: show the chat as unavailable.
        if (!snapshot) {
          publish(mine, mine.view.items, { state: 'unavailable', reason: null, waitingFor: null, source: null }, far);
          return;
        }
        opening = false;
        markChat('view:snapshot');
        finishChatOpen();
        publish(
          mine,
          mergeItems(mine.view.items, snapshot.items ?? [], false),
          snapshot.available
            ? { state: 'ready', reason: null, waitingFor: snapshot.waitingFor ?? null, source: snapshot.source ?? 'file' }
            : { state: 'unavailable', reason: snapshot.reason, waitingFor: null, source: null },
          far,
        );
      })
      .catch((error: unknown) => {
        if (!live) return;
        // A far chat that already shows its transcript keeps it when the PC does not answer (the open is tried again when the link is back).
        const prev = mine.view.status;
        publish(mine, mine.view.items, far && prev.state === 'ready' ? prev : { state: 'unavailable', reason: errorSentence(error), waitingFor: null, source: null }, far);
      });
  };
  const now = Date.now();
  const rushed = now - lastAcquire < chatTuning.settleMs;
  lastAcquire = now;
  if (rushed) timer = setTimeout(start, chatTuning.settleMs);
  else start();
  mine.stop = () => {
    live = false;
    if (timer) clearTimeout(timer);
    for (const off of unlisten) off();
    unlisten = [];
    if (opened) {
      clearChatTiming();
      void closeSessionChat(paneId, surface, host).catch(() => undefined);
    }
  };
  return mine;
}

function release(store: Store): void {
  if (--store.refs > 0) return;
  const end = () => {
    store.closeTimer = null;
    if (store.refs > 0) return;
    if (stores.get(store.key) === store) stores.delete(store.key);
    store.stop?.();
  };
  if (chatTuning.graceMs > 0) store.closeTimer = setTimeout(end, chatTuning.graceMs);
  else end();
}

export function useSessionChat(paneId: string, enabled: boolean, given?: Host): SessionChatHook {
  const ctx = useHost();
  const host = given ?? ctx;
  const far = host.place.kind === 'pc' && host.can?.('session_chat_open') !== false;
  const farKey = `${host.place.kind === 'pc' ? host.place.node : ''}|${paneId}`;
  const startView = (): View => ({ key: '', items: farKept.get(farKey)?.items ?? [], status: farKept.get(farKey)?.status ?? LOADING });
  const [shown, setShown] = useState<View>(startView);
  const storeRef = useRef<Store | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const store = acquire(paneId, host);
    storeRef.current = store;
    setShown(store.view);
    store.subs.add(setShown);
    return () => {
      store.subs.delete(setShown);
      if (storeRef.current === store) storeRef.current = null;
      release(store);
    };
  }, [paneId, enabled, host]);
  // Between a switch and its effect, what is shown is still the last chat: show the kept part of this one, or loading.
  const { items, status } = shown.key.startsWith(`${farKey}#`) ? shown : startView();
  const setItems = useCallback(
    (update: (prev: ChatItem[]) => ChatItem[]) => {
      const store = storeRef.current;
      if (store) publish(store, update(store.view.items), store.view.status, far);
    },
    [far],
  );

  // Older messages, a page at a time (an ACP chat has a journal on the PC; any other chat shows no row).
  const fetchEarlier = useCallback((before: string, limit: number) => chatEarlier(paneId, before, limit, host), [paneId, host]);
  const earlier = useEarlier({ key: paneId, ready: status.state === 'ready', supported: status.source === 'acp', items, setItems, fetchPage: enabled ? fetchEarlier : null });

  // The last result goes back in, so a turn that did not change stays the same object (the view skips it).
  const lastGrouped = useRef<GroupedChat | null>(null);
  const grouped = useMemo(() => (lastGrouped.current = groupTurns(items, lastGrouped.current)), [items]);
  return {
    state: status.state,
    reason: status.reason,
    waitingFor: status.waitingFor,
    source: status.source,
    turns: grouped.turns,
    model: grouped.model,
    cliVersion: grouped.cliVersion,
    usage: grouped.usage,
    plan: grouped.plan,
    outputs: grouped.outputs,
    earlier,
  };
}
