// "Show earlier messages" puts older messages ABOVE what the reader is looking at. Without help the page would jump: the
// same message would move down by the height that was added. `noteWhere()` (called when the row is pressed) remembers the
// height and the place; once the older messages are in (`version` goes up) the scroll moves by exactly what was added above.
import { useCallback, useLayoutEffect, useRef, type MutableRefObject, type RefObject } from 'react';

export function useKeepPlace(scrollRef: RefObject<HTMLElement | null>, atBottom: MutableRefObject<boolean>, version: number): () => void {
  const kept = useRef<{ height: number; top: number } | null>(null);
  const noteWhere = useCallback(() => {
    const el = scrollRef.current;
    if (el) kept.current = { height: el.scrollHeight, top: el.scrollTop };
    // The reader is not at the end any more: new items must not pull the page down.
    atBottom.current = false;
  }, [scrollRef, atBottom]);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const place = kept.current;
    if (!el || !place || version === 0) return;
    kept.current = null;
    el.scrollTop = place.top + (el.scrollHeight - place.height);
  }, [scrollRef, version]);
  return noteWhere;
}
