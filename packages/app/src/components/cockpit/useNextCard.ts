// After a card is answered it leaves the Inbox, and the keyboard would fall to the page. This moves it to the card
// that took its place and says whose card that is ("Next: Codex"), so J/K/1/2 can keep going without the mouse.
import { useCallback, useEffect, useRef, useState, type FocusEvent, type RefObject } from 'react';
import { focusWithRing } from './InboxCard';

/** How long the "Next: ..." line stays. */
export const NEXT_HINT_MS = 4000;

/** The key of the card that takes the place of a removed one: the one now at its spot, else the last. */
export function nextKeyAfter(keys: readonly string[], was: { key: string; index: number }): string | null {
  if (keys.length === 0 || keys.includes(was.key)) return null;
  return keys[Math.min(was.index, keys.length - 1)] ?? null;
}

const cardOf = (root: HTMLElement, key: string): HTMLElement | null =>
  Array.from(root.querySelectorAll<HTMLElement>('[data-ib-key]'))
    .find((li) => li.dataset.ibKey === key)
    ?.querySelector<HTMLElement>('[data-ib-card]') ?? null;

export function useNextCard(root: RefObject<HTMLElement | null>, keys: readonly string[], nameOf: (key: string) => string | undefined) {
  const last = useRef<{ key: string; index: number } | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const nameRef = useRef(nameOf);
  nameRef.current = nameOf;
  const prevKeys = useRef(keys);

  // Remember which card has the keyboard (the card that holds the focused button).
  const onFocus = useCallback(
    (e: FocusEvent<HTMLElement>) => {
      const li = (e.target as Element).closest<HTMLElement>('[data-ib-key]');
      if (!li || !root.current?.contains(li)) return;
      const key = li.dataset.ibKey!;
      last.current = { key, index: prevKeys.current.indexOf(key) };
    },
    [root],
  );

  const sig = keys.join('\n');
  useEffect(() => {
    const before = prevKeys.current;
    prevKeys.current = keys;
    const was = last.current;
    if (!was || was.index < 0) return;
    const key = nextKeyAfter(keys, was);
    if (key === null) {
      // Gone and nothing left, or still here: nothing to move.
      if (!keys.includes(was.key) && before.includes(was.key)) last.current = null;
      return;
    }
    last.current = null;
    const box = root.current;
    if (!box || document.querySelector('.ck-sheet, [aria-modal="true"], .ck-away')) return;
    const active = document.activeElement;
    // Focus that moved by itself into the Inbox (a high-risk card puts it on Deny) or to a field is left alone.
    const inside = !!active && active !== document.body && (box.contains(active) || (active as HTMLElement).isContentEditable);
    if (!inside) focusWithRing(cardOf(box, key));
    setNext(nameRef.current(key) ?? 'next card');
  }, [sig]);

  useEffect(() => {
    if (next === null) return;
    const t = window.setTimeout(() => setNext(null), NEXT_HINT_MS);
    return () => window.clearTimeout(t);
  }, [next]);

  return { next, onFocus };
}
