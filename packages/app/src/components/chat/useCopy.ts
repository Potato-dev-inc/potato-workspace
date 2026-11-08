// "Copy" for a block of text: the clipboard first; when it says no, the text is selected so the person can copy it by
// hand. The state says which one happened, for the button's words, and falls back to idle after a moment.
import { useCallback, useEffect, useRef, useState } from 'react';

export type CopyState = 'idle' | 'copied' | 'selected';

const FEEDBACK_MS = 1500;

/** Selects all the text of an element. Returns whether the browser then copied it (the old command route). */
function selectAndCopy(el: Element | null): boolean {
  if (!el || typeof window === 'undefined' || typeof document === 'undefined') return false;
  try {
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return typeof document.execCommand === 'function' && document.execCommand('copy');
  } catch {
    return false;
  }
}

export function useCopy() {
  const [state, setState] = useState<CopyState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  const copy = useCallback(async (text: string, fallbackEl?: Element | null) => {
    let next: CopyState = 'copied';
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      next = selectAndCopy(fallbackEl ?? null) ? 'copied' : 'selected';
    }
    setState(next);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), FEEDBACK_MS);
  }, []);
  return { state, copy };
}
