// "Nothing draws over the page." The docked browser's page is a native layer that paints above everything the app draws, so
// while a menu, a sheet, a dialog or a toast is over it, or a splitter is being dragged across it, the pane swaps the live
// page for a picture of it (Rust hides the native page, the picture is app content) and swaps it back when that is over.
// The page stays alive while hidden: an agent step that arrives still runs.
import { useEffect, useRef, useState } from 'react';
import { dockFreeze, dockSnapshot, type PageRect } from '../../../lib/dock-browser';

/** What counts as drawn over the page: the shared floating layer, menus, dialogs and sheets. */
const OVERLAYS = '.fl-layer, [role="menu"], [role="dialog"], [role="alertdialog"], [aria-modal="true"], .ck-pop';
/** Toasts and update notices are not blocking: they sit in a corner and the page may cover them. Freezing for them left a grey pane. */
const PASSIVE = '[role="status"], [role="alert"], .app-update-notice, .ck-toasts';
/** A drag of a splitter or an edge happens in the app; the page would take the mouse, so it is frozen for the drag. */
const DRAGGABLE = '.tk-split, .ck-resize, [data-testid="dock-splitter"]';

/** A picture that takes longer than this is not waited for: the page gives way to a plain panel with its title at once. */
const SLOW_PICTURE_MS = 600;

const meets = (a: DOMRect, b: PageRect): boolean => a.width > 0 && a.height > 0 && a.left < b.x + b.width && a.right > b.x && a.top < b.y + b.height && a.bottom > b.y;

/** Is something drawn over the page rectangle right now? The pane's own content is not an overlay. */
export function overlayOverPage(page: PageRect, root: ParentNode = document): boolean {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(OVERLAYS))) {
    if (el.closest('[data-testid="dock-browser"]')) continue;
    if (el.closest(PASSIVE)) continue;
    const r = el.getBoundingClientRect();
    // getBoundingClientRect of a box with no size says nothing; a zero-size layer holds its content in children.
    if (meets(r, page)) return true;
    if (r.width === 0 || r.height === 0) {
      for (const child of Array.from(el.children)) if (meets(child.getBoundingClientRect(), page)) return true;
    }
  }
  return false;
}

/**
 * Freezes the page while something covers it. `page` is the pane's page area element, `rect` its rectangle now.
 * Returns the picture to show (an object URL), or null while the live page shows; `still` is true while frozen.
 */
export function useBrowserFreeze(page: React.RefObject<HTMLElement>, rect: () => PageRect | null, enabled: boolean): { picture: string | null; still: boolean } {
  const [picture, setPicture] = useState<string | null>(null);
  const [still, setStill] = useState(false);
  const state = useRef({ want: false, has: false, busy: false, dragging: false });
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) return undefined;
    const s = state.current;
    let alive = true;
    const settle = async () => {
      if (s.busy) return;
      s.busy = true;
      try {
        // One step at a time; look again at the end in case the want changed meanwhile.
        while (alive && s.want !== s.has) {
          if (s.want) {
            const png = await Promise.race([dockSnapshot(), new Promise<ArrayBuffer>((r) => window.setTimeout(() => r(new ArrayBuffer(0)), SLOW_PICTURE_MS))]);
            if (!alive) return;
            if (png.byteLength > 0) {
              const url = URL.createObjectURL(new Blob([png], { type: 'image/png' }));
              if (urlRef.current) URL.revokeObjectURL(urlRef.current);
              urlRef.current = url;
              setPicture(url);
            } else setPicture(null);
            setStill(true);
            // One frame for the picture to paint, then the native page goes away.
            await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
            await dockFreeze(true);
            s.has = true;
          } else {
            await dockFreeze(false);
            s.has = false;
            await new Promise<void>((r) => requestAnimationFrame(() => r()));
            if (!alive) return;
            setStill(false);
            setPicture(null);
            if (urlRef.current) {
              URL.revokeObjectURL(urlRef.current);
              urlRef.current = null;
            }
          }
        }
      } finally {
        s.busy = false;
      }
    };
    const look = () => {
      const r = rect();
      s.want = s.dragging || (r !== null && overlayOverPage(r));
      void settle();
    };
    // One look per frame, however much the page of the app changes (a streaming chat changes it all the time).
    let frame = 0;
    const later = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        look();
      });
    };
    const onDown = (e: Event) => {
      if ((e.target as Element | null)?.closest?.(DRAGGABLE)) {
        s.dragging = true;
        later();
      }
    };
    const onUp = () => {
      if (s.dragging) {
        s.dragging = false;
        later();
      }
    };
    const watched = document.querySelector('.cockpit') ?? document.body;
    const mo = new MutationObserver(later);
    mo.observe(watched, { childList: true, subtree: true });
    if (watched !== document.body) mo.observe(document.body, { childList: true });
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('pointerup', onUp, true);
    document.addEventListener('mouseup', onUp, true);
    document.addEventListener('pointercancel', onUp, true);
    look();
    return () => {
      alive = false;
      cancelAnimationFrame(frame);
      mo.disconnect();
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('pointerup', onUp, true);
      document.removeEventListener('mouseup', onUp, true);
      document.removeEventListener('pointercancel', onUp, true);
      // Leaving while frozen (the pane closed, another chat): show the page again for the next time it is wanted.
      if (s.has) void dockFreeze(false);
      s.want = false;
      s.has = false;
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current);
        urlRef.current = null;
      }
    };
  }, [enabled, page, rect]);

  return { picture, still };
}
