// Puts the comfort prefs on the page: one root scale variable (--ui-scale, read by html { zoom }), the
// strong-contrast and less-motion switches as attributes, and the Ctrl keys that change the text size.
import { useEffect, useState } from 'react';
import { COMFORT_KEY, reducedMotion, scaleFactor, stepTextScale, type ComfortPrefs } from './model';
import { getComfort, refreshComfortFromStorage, setComfort, useComfort } from './store';

const REDUCE_QUERY = '(prefers-reduced-motion: reduce)';

/** Windows (or the browser) asks for reduced motion right now. */
export function systemReducesMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(REDUCE_QUERY).matches;
}

/** Write the prefs onto the root element. Pure apart from the element it is given. */
export function applyComfortToRoot(root: HTMLElement, prefs: ComfortPrefs, systemReduce: boolean): void {
  root.style.setProperty('--ui-scale', String(scaleFactor(prefs)));
  root.dataset.contrast = prefs.strongContrast ? 'strong' : 'normal';
  root.dataset.motion = reducedMotion(prefs, systemReduce) ? 'less' : 'normal';
}

/** Ctrl+= bigger, Ctrl+- smaller, Ctrl+Shift+0 back to 100%. Plain Ctrl+0 is not used (the agent board takes it). */
export function zoomKeyAction(event: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): 'bigger' | 'smaller' | 'reset' | null {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return null;
  if (event.code === 'Digit0' && event.shiftKey) return 'reset';
  if (event.code === 'Equal' || event.code === 'NumpadAdd') return 'bigger';
  if (event.code === 'Minus' || event.code === 'NumpadSubtract') return 'smaller';
  return null;
}

/**
 * Mount once per window (the cockpit and the settings window). Applies the prefs to the page, follows
 * changes saved by another window, and handles the zoom keys. Screens that only read or change the
 * prefs use useComfort() instead.
 */
export function useComfortRoot(): void {
  const [prefs] = useComfort();
  const [systemReduce, setSystemReduce] = useSystemReduce();

  useEffect(() => {
    applyComfortToRoot(document.documentElement, prefs, systemReduce);
    // Terminals measure their box on resize: a size change must reach them.
    const frame = window.requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
    return () => window.cancelAnimationFrame(frame);
  }, [prefs, systemReduce]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const action = zoomKeyAction(event);
      if (!action) return;
      event.preventDefault();
      const current = getComfort();
      const textScale = action === 'reset' ? stepTextScale(current.textScale, 0) : stepTextScale(current.textScale, action === 'bigger' ? 1 : -1);
      setComfort({ textScale });
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === COMFORT_KEY) refreshComfortFromStorage();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(REDUCE_QUERY);
    const onChange = () => setSystemReduce(query.matches);
    query.addEventListener?.('change', onChange);
    return () => query.removeEventListener?.('change', onChange);
  }, [setSystemReduce]);
}

/** Whether the system asks for reduced motion, kept current. */
function useSystemReduce(): [boolean, (value: boolean) => void] {
  return useState<boolean>(systemReducesMotion);
}
