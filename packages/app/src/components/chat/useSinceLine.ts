// "New since you looked", for one chat: decides once (when the chat first has turns) whether there is a line to show,
// opens the chat at it, and drops it when the reader reaches the end. Used by the desktop chat and the phone chat.
// With everything already in view there is nothing to jump over, so no line. The moment of the last look is kept per
// chat while the reader is at its end (see lib/chatSince.ts).
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { readSeen, sinceReport, writeSeen, type SinceReport } from '../../lib/chatSince';
import type { ChatTurn } from '../../lib/sessionChatModel';

/** Within this many pixels of the end counts as "at the bottom". */
export const SINCE_AT_BOTTOM_PX = 24;
/** The moment of the last look is written at most this often while the chat is open at its end. */
const WRITE_EVERY_MS = 3000;
/** Opening at the line scrolls by itself: a scroll this soon after is not the reader reaching the end. */
const OPEN_GRACE_MS = 800;

export interface SinceLine {
  /** The line is showing, above the first turn of `report`. */
  show: boolean;
  report: SinceReport | null;
  /** The reader reached the end of the chat. */
  reachedEnd: () => void;
  jumpToLatest: () => void;
}

export function useSinceLine(opts: { chatId: string | null | undefined; turns: readonly ChatTurn[]; ready: boolean; scrollRef: RefObject<HTMLElement | null>; atBottom: { current: boolean } }): SinceLine {
  const { chatId, turns, ready, scrollRef, atBottom } = opts;
  const seenAtOpen = useRef<number | null | undefined>(undefined);
  seenAtOpen.current ??= chatId ? readSeen(chatId) : null;
  const [since, setSince] = useState<'pending' | 'show' | 'none'>('pending');
  const shownAt = useRef(0);
  const report = useMemo(() => (seenAtOpen.current ? sinceReport(turns, seenAtOpen.current) : null), [turns]);

  useLayoutEffect(() => {
    if (since !== 'pending' || !ready || turns.length === 0) return;
    const el = scrollRef.current;
    const fits = !el || el.scrollHeight - el.clientHeight <= SINCE_AT_BOTTOM_PX;
    if (report && !fits) {
      atBottom.current = false;
      shownAt.current = Date.now();
      setSince('show');
    } else {
      setSince('none');
    }
  }, [since, ready, turns, report, scrollRef, atBottom]);

  // Open at the line.
  useLayoutEffect(() => {
    if (since === 'show') scrollRef.current?.querySelector('[data-since]')?.scrollIntoView?.({ block: 'start' });
  }, [since, scrollRef]);

  const lastWrite = useRef(0);
  const keepSeen = (force: boolean) => {
    if (!chatId || since === 'pending' || !atBottom.current) return;
    // While the line shows, only leaving the chat at its end counts as having seen it.
    if (since === 'show' && !force) return;
    const now = Date.now();
    if (!force && now - lastWrite.current < WRITE_EVERY_MS) return;
    lastWrite.current = now;
    writeSeen(chatId, now);
  };
  useEffect(() => keepSeen(false), [turns, since]); // eslint-disable-line react-hooks/exhaustive-deps
  const keepSeenNow = useRef(keepSeen);
  keepSeenNow.current = keepSeen;
  useEffect(() => () => keepSeenNow.current(true), []);

  const drop = () => {
    if (since !== 'show') return;
    setSince('none');
    if (chatId) writeSeen(chatId, Date.now());
  };
  const reachedEnd = () => {
    if (Date.now() - shownAt.current >= OPEN_GRACE_MS) drop();
  };
  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    atBottom.current = true;
    drop();
  };
  return { show: since === 'show', report, reachedEnd, jumpToLatest };
}
