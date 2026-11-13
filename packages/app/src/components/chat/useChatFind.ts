// The state behind "Find in this chat" (Ctrl+F): the query, every match found in the page text, which one is
// current, and the marks. Matches are read from the text on the page (ranges, no change to the page), so folded
// rows that hold a match must be open first (see chatFind.tsx); the count follows the page as rows open.
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

/** The most matches that are marked: a very common word would otherwise make a very long list. */
export const MAX_FIND_MATCHES = 2000;

/** Every case-insensitive match of `query` in the text nodes under `root`, in page order. */
export function findRanges(root: Element, query: string): Range[] {
  const needle = query.toLowerCase();
  if (needle === '') return [];
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node && ranges.length < MAX_FIND_MATCHES; node = walker.nextNode()) {
    const hay = (node.nodeValue ?? '').toLowerCase();
    let at = hay.indexOf(needle);
    while (at >= 0 && ranges.length < MAX_FIND_MATCHES) {
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      ranges.push(range);
      at = hay.indexOf(needle, at + needle.length);
    }
  }
  return ranges;
}

interface HighlightRegistry {
  set: (name: string, value: unknown) => void;
  delete: (name: string) => void;
}
const registry = (): HighlightRegistry | null => (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS?.highlights ?? null;
const makeHighlight = (ranges: Range[]): unknown => {
  const ctor = (globalThis as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
  return ctor ? new ctor(...ranges) : null;
};

export interface ChatFind {
  open: boolean;
  query: string;
  setQuery: (value: string) => void;
  total: number;
  /** The current match, 0-based (0 when there is none). */
  index: number;
  next: () => void;
  prev: () => void;
  show: () => void;
  /** Closes the box and gives the keyboard back to the message box. */
  close: () => void;
}

export function useChatFind(root: RefObject<HTMLElement | null>, focusComposer: () => void): ChatFind {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [total, setTotal] = useState(0);
  const [index, setIndex] = useState(0);
  const ranges = useRef<Range[]>([]);
  const lastQuery = useRef('');

  const scan = useCallback(() => {
    const el = root.current;
    ranges.current = open && el ? findRanges(el, query) : [];
    setTotal(ranges.current.length);
  }, [root, open, query]);

  // A new query starts at its first match.
  useEffect(() => {
    if (query !== lastQuery.current) {
      lastQuery.current = query;
      setIndex(0);
    }
  }, [query]);

  // Scan after the page has drawn (folded rows open one render later) and again whenever the page changes.
  useEffect(() => {
    scan();
    const el = root.current;
    if (!open || !el || typeof MutationObserver === 'undefined') return;
    let frame = 0;
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(scan);
    });
    observer.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [scan, open, root]);

  const current = total === 0 ? 0 : Math.min(index, total - 1);

  // The marks, and the current match scrolled into view.
  useEffect(() => {
    const reg = registry();
    const all = ranges.current;
    if (reg && open && all.length > 0) {
      const others = makeHighlight(all.filter((_, i) => i !== current));
      const here = makeHighlight([all[current]]);
      if (others) reg.set('pm-find', others);
      if (here) reg.set('pm-find-active', here);
    } else {
      reg?.delete('pm-find');
      reg?.delete('pm-find-active');
    }
    const at = all[current];
    if (open && at) at.startContainer.parentElement?.scrollIntoView?.({ block: 'center' });
    return () => {
      reg?.delete('pm-find');
      reg?.delete('pm-find-active');
    };
  }, [open, current, total, query]);

  const step = useCallback(
    (by: number) => {
      if (total === 0) return;
      setIndex((current + by + total) % total);
    },
    [current, total],
  );

  return {
    open,
    query,
    setQuery,
    total,
    index: current,
    next: () => step(1),
    prev: () => step(-1),
    show: () => setOpen(true),
    close: () => {
      setOpen(false);
      setQuery('');
      focusComposer();
    },
  };
}

/** Ctrl+F (Cmd+F on a Mac) with nothing else held. */
export function isFindKey(event: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f';
}
