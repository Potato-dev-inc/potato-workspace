// When the peek card of a sidebar row is open: the pointer rests on the row for 400 ms, or Space on a focused row.
// It closes when the pointer has left both the row and the card (after a short grace), on Esc, when focus leaves the
// row (if the keyboard opened it), on a click, a drag, a context menu or a scroll. It never moves focus.
import { useCallback, useEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { PEEK_DELAY_MS, PEEK_GRACE_MS } from './peek-model';

export interface PeekOpen {
  id: string;
  /** Where the card goes (fixed, in window pixels). */
  left: number;
  top: number;
  via: 'pointer' | 'key';
}

const CARD_W = 280;
const CARD_H = 260;

/** Right of the row, level with it, kept inside the window. */
export function peekPosition(row: { left: number; right: number; top: number }, win: { width: number; height: number }): { left: number; top: number } {
  const wantLeft = row.right + 8;
  const left = wantLeft + CARD_W + 8 > win.width ? Math.max(8, row.left - CARD_W - 8) : wantLeft;
  const top = Math.max(8, Math.min(row.top - 6, win.height - CARD_H - 8));
  return { left, top };
}

export interface PeekControl {
  open: PeekOpen | null;
  close: () => void;
  /** Props for the wrapper of one row. */
  rowProps: (id: string) => {
    onMouseEnter: (e: MouseEvent<HTMLElement>) => void;
    onMouseLeave: () => void;
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
    onKeyUp: (e: KeyboardEvent<HTMLElement>) => void;
    onBlur: (e: FocusEvent<HTMLElement>) => void;
    onMouseDownCapture: (e: MouseEvent<HTMLElement>) => void;
    onContextMenuCapture: (e: MouseEvent<HTMLElement>) => void;
    onDragStartCapture: () => void;
  };
  /** The pointer is on the card or left it. */
  onCardHover: (on: boolean) => void;
}

export function usePeek(enabled = true): PeekControl {
  const [open, setOpen] = useState<PeekOpen | null>(null);
  const delay = useRef<number | null>(null);
  const grace = useRef<number | null>(null);
  const overRow = useRef(false);
  const overCard = useRef(false);
  const swallowSpaceUp = useRef(false);

  const clearTimers = () => {
    if (delay.current !== null) window.clearTimeout(delay.current);
    if (grace.current !== null) window.clearTimeout(grace.current);
    delay.current = null;
    grace.current = null;
  };
  const close = useCallback(() => {
    clearTimers();
    overRow.current = false;
    overCard.current = false;
    setOpen(null);
  }, []);
  useEffect(() => clearTimers, []);

  const leaveSoon = () => {
    if (grace.current !== null) window.clearTimeout(grace.current);
    grace.current = window.setTimeout(() => {
      grace.current = null;
      if (!overRow.current && !overCard.current) setOpen((cur) => (cur && cur.via === 'pointer' ? null : cur));
    }, PEEK_GRACE_MS);
  };

  // A scroll anywhere moves the row away from the card.
  useEffect(() => {
    if (!open) return;
    const onScroll = () => close();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  const placeFor = (el: HTMLElement) => peekPosition(el.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight });

  const rowProps: PeekControl['rowProps'] = (id) => ({
    onMouseEnter: (e) => {
      if (!enabled) return;
      overRow.current = true;
      if (grace.current !== null) window.clearTimeout(grace.current);
      grace.current = null;
      if (open?.id === id) return;
      if (delay.current !== null) window.clearTimeout(delay.current);
      const row = e.currentTarget;
      delay.current = window.setTimeout(() => {
        delay.current = null;
        if (overRow.current) setOpen({ id, ...placeFor(row), via: 'pointer' });
      }, PEEK_DELAY_MS);
    },
    onMouseLeave: () => {
      overRow.current = false;
      if (delay.current !== null) window.clearTimeout(delay.current);
      delay.current = null;
      if (open) leaveSoon();
    },
    onKeyDown: (e) => {
      if (!enabled || e.key !== ' ' || e.repeat) return;
      const target = e.target as HTMLElement;
      if (!target.matches('[data-pane-row]')) return;
      // Space opens (or closes) the card instead of pressing the row.
      e.preventDefault();
      swallowSpaceUp.current = true;
      if (open?.id === id) close();
      else setOpen({ id, ...placeFor(e.currentTarget), via: 'key' });
    },
    onKeyUp: (e) => {
      if (e.key === ' ' && swallowSpaceUp.current) {
        swallowSpaceUp.current = false;
        e.preventDefault();
      }
    },
    onBlur: (e) => {
      if (open?.id !== id || open.via !== 'key') return;
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) close();
    },
    onMouseDownCapture: (e) => {
      // A press on the card's own buttons is theirs.
      if ((e.target as HTMLElement).closest('.ck-peek')) return;
      if (open || delay.current !== null) close();
    },
    onContextMenuCapture: (e) => {
      if (!(e.target as HTMLElement).closest('.ck-peek')) close();
    },
    onDragStartCapture: () => close(),
  });

  const onCardHover = (on: boolean) => {
    overCard.current = on;
    if (on) {
      if (grace.current !== null) window.clearTimeout(grace.current);
      grace.current = null;
    } else leaveSoon();
  };

  return { open, close, rowProps, onCardHover };
}
