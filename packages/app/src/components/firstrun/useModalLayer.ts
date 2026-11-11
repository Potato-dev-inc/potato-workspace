// Makes the welcome a real modal: while it is open, the rest of the cockpit is inert and hidden from screen readers,
// Tab stays inside it, Esc leaves it, and focus goes back to where it was when it closes. Things that open later
// (the command palette on Ctrl+K) are new elements, so they are not inert and still work above it.
import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';

const FOCUSABLE = 'a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])';

/** The controls Tab can reach inside `root`, in order. */
export function tabStops(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute('disabled') && el.getAttribute('tabindex') !== '-1' && !el.closest('[hidden], [inert]'),
  );
}

export function useModalLayer({
  layer,
  shell,
  active,
  onEscape,
}: {
  layer: RefObject<HTMLElement | null>;
  shell: RefObject<HTMLElement | null>;
  /** False while the welcome is paused as a bar: the cockpit works then. */
  active: boolean;
  onEscape: () => void;
}): { onKeyDown: (e: KeyboardEvent) => void } {
  // Where focus was before the welcome opened (the palette entry, the Inbox button, or nothing).
  const [opener] = useState<Element | null>(() => (typeof document === 'undefined' ? null : document.activeElement));
  const escape = useRef(onEscape);
  escape.current = onEscape;

  // Everything else on the page is out of reach while the modal is active.
  useEffect(() => {
    const box = layer.current;
    const parent = box?.parentElement;
    if (!active || !box || !parent) return;
    const touched: Element[] = [];
    for (const el of Array.from(parent.children)) {
      if (el === box || el.classList.contains('ck-toasts') || el.hasAttribute('inert')) continue;
      el.setAttribute('inert', '');
      el.setAttribute('aria-hidden', 'true');
      touched.push(el);
    }
    return () => {
      for (const el of touched) {
        el.removeAttribute('inert');
        el.removeAttribute('aria-hidden');
      }
    };
  }, [active, layer]);

  // Focus moves in when the modal opens (or comes back from a pause) and stays in.
  useEffect(() => {
    if (!active) return;
    shell.current?.focus({ preventScroll: true });
    const keepIn = (e: FocusEvent) => {
      const box = layer.current;
      const target = e.target;
      if (!box || !(target instanceof Node) || box.contains(target)) return;
      // A palette or sheet opened on top is allowed to hold focus.
      if (target instanceof Element && target.closest('[role="dialog"], [aria-modal="true"]')) return;
      shell.current?.focus({ preventScroll: true });
    };
    document.addEventListener('focusin', keepIn);
    return () => document.removeEventListener('focusin', keepIn);
  }, [active, layer, shell]);

  // Closing hands focus back.
  useEffect(
    () => () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    },
    [opener],
  );

  const onKeyDown = (e: KeyboardEvent) => {
    const box = shell.current;
    if (!active || !box) return;
    if (e.key === 'Escape') {
      if (e.defaultPrevented) return;
      const target = e.target as HTMLElement;
      // Esc inside a text box belongs to that box. On an open fold-away it closes the fold-away first; the next Esc leaves.
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (target.getAttribute('aria-expanded') === 'true') {
        e.preventDefault();
        target.click();
        return;
      }
      e.preventDefault();
      escape.current();
      return;
    }
    if (e.key !== 'Tab') return;
    const stops = tabStops(box);
    if (stops.length === 0) {
      e.preventDefault();
      box.focus();
      return;
    }
    const first = stops[0];
    const last = stops[stops.length - 1];
    const at = document.activeElement;
    if (e.shiftKey && (at === first || at === box)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && at === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return { onKeyDown };
}
