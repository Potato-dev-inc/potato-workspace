// The data of a chat that runs on another PC, in the shape the normal chat screen (SessionChatView) takes. It is the same
// read of the PC link (`GET /pclink/sessions/:id/transcript`, asked again every 3 s while the chat is open and focused, every 15 s unfocused, slower after failures, not at all while hidden). The far PC enforces its rights; a refusal here only becomes one plain sentence.
import { useEffect, useMemo, useRef, useState } from 'react';
import { t as translate } from '../../i18n';
import { useEarlier, type EarlierState } from '../../hooks/useEarlier';
import type { PcLinkClient } from './pclink';
import { pollWithBackoff } from './pollWithBackoff';
import type { PictureSource } from '../chatMore';
import { errorSentence } from '../sayError';
import { groupTurns, mergeItems, type ChatItem, type ChatSource, type GroupedChat, type SessionChatState } from '../sessionChatModel';

/** How often the far PC is asked while the chat is on screen. */
export const REMOTE_CHAT_POLL_MS = 3000;
/** How often a chat is read while its window does not have the focus. */
export const REMOTE_CHAT_UNFOCUSED_POLL_MS = 15_000;
/** Items kept in the list; the oldest go first. */
const MAX_KEPT = 4000;

export interface RemoteChatStatus {
  state: SessionChatState;
  reason: string | null;
  waitingFor: string | null;
  source: ChatSource | null;
}

const LOADING: RemoteChatStatus = { state: 'loading', reason: null, waitingFor: null, source: null };

const sameStatus = (a: RemoteChatStatus, b: RemoteChatStatus) => a.state === b.state && a.reason === b.reason && a.waitingFor === b.waitingFor && a.source === b.source;

/** The far PC refused this PC (no `watch`) or the chat is gone there: asking again changes nothing. */
export function refusalOf(error: unknown): string | null {
  const text = errorSentence(error);
  if (/ -> 403/.test(text)) return translate('phone.conv.noWatch');
  if (/ -> 404/.test(text)) return translate('phone.conv.gone');
  return null;
}

export interface RemoteChat {
  status: RemoteChatStatus;
  grouped: GroupedChat;
  earlier: EarlierState;
  pictures: PictureSource | null;
}

const CACHE_PREFIX = 'pm.remoteChat.';
/** Per chat: the last this many items. Across chats: the last this many chats read (the least recently used go first). */
export const CACHE_KEEP = 200;
export const CACHE_MAX_CHATS = 20;
/** The chats kept, least recently used first. Kept next to them so the whole cache can be trimmed or cleared without scanning storage. */
const CACHE_INDEX = 'pm.remoteChat.__index';

function readIndex(): string[] {
  try {
    const list = JSON.parse(window.localStorage.getItem(CACHE_INDEX) ?? '[]') as unknown;
    return Array.isArray(list) ? list.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}
function writeIndex(keys: readonly string[]): void {
  try {
    window.localStorage.setItem(CACHE_INDEX, JSON.stringify(keys));
  } catch {
    /* closed storage: nothing is kept anyway */
  }
}

/** Forgets what was kept of the chats of one PC (`device:<node>:`), because that PC was unlinked or removed. */
export function clearRemoteChatCache(node: string): void {
  try {
    const prefix = `device:${node}:`;
    const left = readIndex().filter((k) => {
      if (!k.startsWith(prefix)) return true;
      window.localStorage.removeItem(CACHE_PREFIX + k);
      return false;
    });
    // A chat written before the index existed is found by its name.
    for (let i = window.localStorage.length - 1; i >= 0; i -= 1) {
      const name = window.localStorage.key(i);
      if (name && name.startsWith(CACHE_PREFIX + prefix)) window.localStorage.removeItem(name);
    }
    writeIndex(left);
  } catch {
    /* closed storage */
  }
}

/** The last words read from another PC's chat, so its transcript can still be read when that PC is away. Words only; storage may be closed. */
export function readCache(key: string | null): ChatItem[] {
  if (!key) return [];
  try {
    const list = JSON.parse(window.localStorage.getItem(CACHE_PREFIX + key) ?? '[]') as unknown;
    return Array.isArray(list) ? (list as ChatItem[]) : [];
  } catch {
    return [];
  }
}
export function writeCache(key: string, items: readonly ChatItem[]): void {
  try {
    window.localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(items.slice(-CACHE_KEEP)));
    // Most recently written goes last; past the cap the oldest chats are dropped.
    const order = [...readIndex().filter((k) => k !== key), key];
    for (const old of order.splice(0, Math.max(0, order.length - CACHE_MAX_CHATS))) window.localStorage.removeItem(CACHE_PREFIX + old);
    writeIndex(order);
  } catch {
    /* too big or closed: the transcript is simply not kept */
  }
}

/** `cacheKey` (device and chat) keeps the last transcript for a PC that goes away; `active` false means the PC is away (nothing is asked). */
export function useRemoteChat(client: PcLinkClient | null, paneId: string, canWatch: boolean, active = true, cacheKey: string | null = null): RemoteChat {
  const [items, setItems] = useState<ChatItem[]>(() => readCache(cacheKey));
  const [status, setStatus] = useState<RemoteChatStatus>(() => (!active && readCache(cacheKey).length > 0 ? { state: 'ready', reason: null, waitingFor: null, source: 'file' } : LOADING));
  const revRef = useRef<number | undefined>(undefined);
  const heldRef = useRef(0);
  heldRef.current = items.length;

  // Another chat starts from nothing.
  useEffect(() => {
    revRef.current = undefined;
    const kept = readCache(cacheKey);
    setItems(kept);
    setStatus(!active && kept.length > 0 ? { state: 'ready', reason: null, waitingFor: null, source: 'file' } : LOADING);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId, client, cacheKey]);
  // The PC went away with a transcript held: it stays on screen, read-only.
  useEffect(() => {
    if (!active && heldRef.current > 0) setStatus((prev) => (prev.state === 'ready' ? prev : { state: 'ready', reason: null, waitingFor: null, source: 'file' }));
  }, [active]);
  useEffect(() => {
    if (!cacheKey || items.length === 0 || !active) return;
    const timer = window.setTimeout(() => writeCache(cacheKey, items), 2000);
    return () => window.clearTimeout(timer);
  }, [cacheKey, items, active]);

  useEffect(() => {
    if (!client || !canWatch || !active) return;
    let live = true;
    const ask = client.transcript.bind(client);
    const show = (next: RemoteChatStatus) => setStatus((prev) => (sameStatus(prev, next) ? prev : next));
    const tick = async (): Promise<'stop' | void> => {
      try {
        const reply = await ask(paneId, revRef.current);
        if (!live) return;
        if (!reply.available) {
          revRef.current = undefined;
          setItems((prev) => (prev.length === 0 ? prev : []));
          show({ state: 'unavailable', reason: reply.reason, waitingFor: null, source: null });
        } else {
          revRef.current = reply.rev;
          if (reply.reset || reply.items.length > 0) setItems((prev) => mergeItems(prev, reply.items, reply.reset).slice(-MAX_KEPT));
          show({ state: 'ready', reason: null, waitingFor: reply.waitingFor ?? null, source: reply.source ?? 'file' });
        }
      } catch (error) {
        if (!live) return;
        const refused = refusalOf(error);
        if (refused) {
          show({ state: 'unavailable', reason: refused, waitingFor: null, source: null });
          return 'stop';
        }
        if (revRef.current === undefined) {
          // Never loaded: the words already on screen stay, else one plain sentence. A far PC that went away leaves its last text.
          if (heldRef.current > 0) show({ state: 'ready', reason: null, waitingFor: null, source: 'file' });
          else show({ state: 'unavailable', reason: translate('phone.conv.unreachable'), waitingFor: null, source: null });
        }
        throw error;
      }
    };
    const focused = () => (typeof document !== 'undefined' && typeof document.hasFocus === 'function' ? document.hasFocus() : true);
    const stop = pollWithBackoff({
      node: client.node,
      route: `transcript:${paneId}`,
      normalMs: () => (focused() ? REMOTE_CHAT_POLL_MS : REMOTE_CHAT_UNFOCUSED_POLL_MS),
      run: tick,
    });
    return () => {
      live = false;
      stop();
    };
  }, [client, paneId, canWatch, active]);

  const lastGrouped = useRef<GroupedChat | null>(null);
  const grouped = useMemo(() => (lastGrouped.current = groupTurns(items, lastGrouped.current)), [items]);
  const fetchEarlier = useMemo(() => (client && canWatch ? (before: string, limit: number) => client.transcriptEarlier(paneId, before, limit) : null), [client, paneId, canWatch]);
  const earlier = useEarlier({ key: paneId, ready: status.state === 'ready', supported: status.source === 'acp', items, setItems, fetchPage: fetchEarlier });
  const pictures = useMemo<PictureSource | null>(() => (client && canWatch ? { key: `device:${paneId}`, load: (path) => client.picture(paneId, path) } : null), [client, paneId, canWatch]);
  return { status, grouped, earlier, pictures };
}
