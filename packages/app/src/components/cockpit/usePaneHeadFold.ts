// How many of the pane header's actions have to move into the ⋯ menu so nothing is cut at the right edge.
// 0 = everything shows. Each step moves the next-lowest priority group away (see PaneView). The header measures itself:
// while its content is wider than it is, it takes one more step (before the browser paints); when the pane is resized
// it starts again from 0, so a wider pane gets its buttons back.
import { useLayoutEffect, useReducer, useRef, useState, type RefObject } from 'react';

export const MAX_FOLD = 3;

export function useHeadFold(ref: RefObject<HTMLElement | null>, watch: unknown): number {
  const [fold, setFold] = useState(0);
  // Starting again from 0 must render even when the count already is 0, so the width is measured again.
  const [, again] = useReducer((n: number) => n + 1, 0);
  const restart = () => {
    setFold(0);
    again();
  };
  // After every render: still too wide? take one more step.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && fold < MAX_FOLD && el.scrollWidth > el.clientWidth + 1) setFold(fold + 1);
  });
  // A resize or new content (watch) starts the count again.
  const first = useRef(true);
  useLayoutEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    restart();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watch]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let width = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth !== width) {
        width = el.clientWidth;
        restart();
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref]);
  return fold;
}
