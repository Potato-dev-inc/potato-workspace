// ONE closing behaviour for every dropdown, menu and popover in the app. While `open` is true the popover closes when:
//   - the person presses the mouse, a finger or a pen anywhere outside it ("outside"), even where a child stops the event
//   - Escape is pressed ("escape")
//   - the keyboard focus moves to something outside it ("focus")
//   - the window loses focus, for example a click into an embedded page or another app ("blur")
//   - the page behind it scrolls ("scroll"): the document, or a scroll area that holds the anchor. A list scrolling
//     inside the popover itself, or unrelated content scrolling on its own (a chat filling up), does not close it.
// `inside` lists what counts as inside: the popover and the button that opened it. Closing runs `onDismiss(why)`.
import { useEffect, useRef, type RefObject } from 'react';

export type DismissReason = 'outside' | 'escape' | 'focus' | 'blur' | 'scroll';

export interface DismissOptions {
  /** Elements that count as inside: the popover itself and its anchor button. */
  inside: ReadonlyArray<RefObject<Element | null>>;
  onDismiss: (why: DismissReason) => void;
  /** Elements that count as inside right now besides `inside`: layers opened from within this one (a menu in a card). */
  extra?: () => ReadonlyArray<Element>;
  /** Which element's scroll ancestors close the popover. Defaults to the first of `inside`. */
  anchor?: RefObject<Element | null>;
  /** Turn single reasons off (a popover that must survive a window blur, for example). */
  ignore?: ReadonlyArray<DismissReason>;
}

/** True when `target` is inside one of the elements. */
export function isInside(target: EventTarget | null, inside: DismissOptions['inside'], extra?: DismissOptions['extra']): boolean {
  if (!(target instanceof Node)) return false;
  return inside.some((ref) => ref.current?.contains(target)) || (extra?.() ?? []).some((el) => el.contains(target));
}

export function useDismissable(open: boolean, options: DismissOptions): void {
  const latest = useRef(options);
  latest.current = options;
  useEffect(() => {
    if (!open) return undefined;
    const dismiss = (why: DismissReason) => {
      if (latest.current.ignore?.includes(why)) return;
      latest.current.onDismiss(why);
    };
    const press = (e: Event) => {
      if (!isInside(e.target, latest.current.inside, latest.current.extra)) dismiss('outside');
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss('escape');
    };
    const focus = (e: FocusEvent) => {
      if (e.target instanceof Node && !isInside(e.target, latest.current.inside, latest.current.extra)) dismiss('focus');
    };
    const blur = () => dismiss('blur');
    const scroll = (e: Event) => {
      const { inside, anchor, extra } = latest.current;
      if (isInside(e.target, inside, extra)) return; // the popover's own list scrolling
      const anchorEl = anchor?.current ?? inside[0]?.current ?? null;
      const t = e.target;
      const isPage = t === document || t === document.documentElement || t === document.body || t === window;
      if (isPage || (t instanceof Node && anchorEl !== null && t.contains(anchorEl))) dismiss('scroll');
    };
    // Capture phase: a child that stops the event cannot hide the press from us.
    document.addEventListener('pointerdown', press, true);
    document.addEventListener('mousedown', press, true);
    document.addEventListener('keydown', key, true);
    document.addEventListener('focusin', focus, true);
    window.addEventListener('blur', blur);
    window.addEventListener('scroll', scroll, true);
    return () => {
      document.removeEventListener('pointerdown', press, true);
      document.removeEventListener('mousedown', press, true);
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('focusin', focus, true);
      window.removeEventListener('blur', blur);
      window.removeEventListener('scroll', scroll, true);
    };
  }, [open]);
}
