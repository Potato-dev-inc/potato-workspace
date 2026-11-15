// Inbox rows open their chat when the person clicks the row itself (or presses Enter on it), not only the small
// button. A click on a real control inside the row (Answer, Open, Review, a link, a field) is left to that control.
import type { KeyboardEvent, MouseEvent } from 'react';

const CONTROL = 'button, a, input, textarea, select, summary, label, [role="button"], [contenteditable="true"]';

/** True when the event started on a control inside `row` (so the row itself must not act). */
export function onControl(e: { target: EventTarget | null; currentTarget: EventTarget | null }): boolean {
  const el = e.target instanceof Element ? e.target.closest(CONTROL) : null;
  return !!el && el !== e.currentTarget && (e.currentTarget as Element).contains(el);
}

/** Props that make a row open on click and on Enter. */
export function rowOpenProps(open: (() => void) | undefined) {
  if (!open) return {};
  return {
    onClick: (e: MouseEvent) => {
      if (e.defaultPrevented || onControl(e)) return;
      open();
    },
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.defaultPrevented || !(e.target === e.currentTarget || (e.target as Element).hasAttribute?.('data-ib-card'))) return;
      e.preventDefault();
      open();
    },
  };
}
