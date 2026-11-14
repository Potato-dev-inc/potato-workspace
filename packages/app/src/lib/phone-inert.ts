// While a drawer or sheet is open, the screen behind it must not be reachable: no Tab into it, no screen-reader reading of it.
// React 18 has no `inert` prop, so this sets the attribute on the element itself and takes it off again when `blocked` ends.
import { useEffect, type RefObject } from 'react';

export function useInertWhile(ref: RefObject<HTMLElement | null>, blocked: boolean): void {
  useEffect(() => {
    const el = ref.current;
    if (!el || !blocked) return;
    el.setAttribute('inert', '');
    el.setAttribute('aria-hidden', 'true');
    return () => {
      el.removeAttribute('inert');
      el.removeAttribute('aria-hidden');
    };
  }, [ref, blocked]);
}
