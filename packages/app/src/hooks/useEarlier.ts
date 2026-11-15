// "Show earlier messages": the state behind the row at the top of a long chat. The chat holds the newest items (the PC keeps a
// window); everything older is in the chat's journal on the PC, read a page at a time. The desktop chat and the phone chat
// both use this; each gives it how to ask its own PC. A chat that has no journal (an agent read from a session file or the
// screen) answers "nothing earlier" and the row never shows.
import { useCallback, useEffect, useRef, useState } from 'react';
import { EARLIER_PAGE, earliestAnchor, prependItems, type EarlierPage } from '../lib/chatMore';
import type { ChatItem } from '../lib/sessionChatModel';

export interface EarlierState {
  /** There is more before the first message held: the row shows. */
  more: boolean;
  busy: boolean;
  /** The last press could not load: the row says so and the next press tries again. */
  failed: boolean;
  /** Goes up each time a page was put in front, so the view can keep its place. */
  version: number;
  show: () => void;
}

export const NO_EARLIER: EarlierState = { more: false, busy: false, failed: false, version: 0, show: () => undefined };

export interface UseEarlierOptions {
  /** A different chat starts again. */
  key: string;
  /** The chat is loaded: only then is the PC asked. */
  ready: boolean;
  /** This chat can have a journal behind it (an ACP chat); anything else shows no row. */
  supported: boolean;
  items: readonly ChatItem[];
  setItems: (update: (prev: ChatItem[]) => ChatItem[]) => void;
  /** Asks the PC; `null` when this client cannot (an old PC). */
  fetchPage: ((before: string, limit: number) => Promise<EarlierPage>) | null;
}

export function useEarlier({ key, ready, supported, items, setItems, fetchPage }: UseEarlierOptions): EarlierState {
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [version, setVersion] = useState(0);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;
  /** The first message the answer about "more" was for: asked again only when the first message changes. */
  const knownFor = useRef<string | null>(null);
  const busyRef = useRef(false);
  const live = useRef(true);
  const anchor = earliestAnchor(items);
  const enabled = supported && ready && fetchPage !== null;

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  // A different chat starts from nothing.
  useEffect(() => {
    knownFor.current = null;
    busyRef.current = false;
    setMore(false);
    setBusy(false);
    setFailed(false);
    setVersion(0);
  }, [key]);

  // Is there anything before the first message held? Asked once for each first message (limit 0: only the answer).
  useEffect(() => {
    if (!enabled || !anchor || knownFor.current === anchor || busyRef.current) return;
    knownFor.current = anchor;
    const ask = fetchRef.current;
    if (!ask) return;
    ask(anchor, 0).then(
      (page) => {
        if (live.current && knownFor.current === anchor) setMore(Boolean(page && page.more));
      },
      () => undefined,
    );
  }, [enabled, anchor, key]);

  const show = useCallback(() => {
    const ask = fetchRef.current;
    const before = earliestAnchor(itemsRef.current);
    if (!ask || !before || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setFailed(false);
    ask(before, EARLIER_PAGE).then(
      (page) => {
        busyRef.current = false;
        if (!live.current) return;
        const older = page && Array.isArray(page.items) ? page.items : [];
        if (older.length > 0) {
          const merged = prependItems(itemsRef.current, older);
          knownFor.current = earliestAnchor(merged);
          setItems((prev) => prependItems(prev, older));
          setVersion((n) => n + 1);
        }
        setMore(Boolean(page && page.more) && older.length > 0);
        setBusy(false);
      },
      () => {
        busyRef.current = false;
        if (!live.current) return;
        setBusy(false);
        setFailed(true);
      },
    );
  }, [setItems]);

  return { more: enabled && more, busy, failed, version, show };
}
