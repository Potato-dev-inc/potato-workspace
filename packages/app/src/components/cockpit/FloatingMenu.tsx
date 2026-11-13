// A pop-up menu drawn in the app's top layer (a portal into the cockpit root, position: fixed), so no pane, rail or
// card with overflow can clip it. It sits under its button and flips above it when there is no room below; it slides
// sideways to stay inside the window. Keyboard: opening focuses the first item, Up/Down move, Escape closes and gives
// the focus back, Tab or a press outside closes.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

/** Space kept between the menu and the window edge (px). */
export const FLOAT_EDGE = 8;
const FLOAT_GAP = 6;

export interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface FloatPlace {
  left: number;
  top: number;
  maxHeight: number;
  /** True when the menu opened above its button. */
  up: boolean;
}

/** Where the menu goes. Pure. `align` says which edge of the button the menu lines up with; `prefer` is the side it tries first. */
export function placeFloating(
  anchor: Box,
  size: { width: number; height: number },
  view: { width: number; height: number },
  align: 'start' | 'end' = 'end',
  prefer: 'down' | 'up' = 'down',
): FloatPlace {
  const below = view.height - anchor.bottom - FLOAT_GAP - FLOAT_EDGE;
  const above = anchor.top - FLOAT_GAP - FLOAT_EDGE;
  const fitsBelow = size.height <= below;
  const fitsAbove = size.height <= above;
  const up = prefer === 'up' ? fitsAbove || (!fitsBelow && above > below) : !fitsBelow && (fitsAbove || above > below);
  const room = Math.max(80, up ? above : below);
  const height = Math.min(size.height, room);
  const top = up ? anchor.top - FLOAT_GAP - height : anchor.bottom + FLOAT_GAP;
  const raw = align === 'end' ? anchor.right - size.width : anchor.left;
  const left = Math.max(FLOAT_EDGE, Math.min(raw, view.width - FLOAT_EDGE - size.width));
  return { left: Math.round(left), top: Math.round(Math.max(FLOAT_EDGE, top)), maxHeight: Math.round(room), up };
}

const ITEMS = '[role^="menuitem"], [role="radio"]';

export function FloatingMenu({
  anchorRef,
  onClose,
  align = 'end',
  prefer = 'down',
  className = '',
  label,
  children,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  /** Called when the menu should close; `returnFocus` is true after Escape. */
  onClose: (returnFocus: boolean) => void;
  align?: 'start' | 'end';
  prefer?: 'down' | 'up';
  className?: string;
  label?: string;
  children: ReactNode;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<FloatPlace | null>(null);
  const close = useRef(onClose);
  close.current = onClose;

  const measure = () => {
    const el = menuRef.current;
    const anchor = anchorRef.current;
    if (!el || !anchor) return;
    const r = anchor.getBoundingClientRect();
    const size = { width: el.offsetWidth, height: el.scrollHeight };
    setPlace(placeFloating(r, size, { width: window.innerWidth, height: window.innerHeight }, align, prefer));
  };
  useLayoutEffect(measure, [align, prefer, children]);

  useEffect(() => {
    menuRef.current?.querySelector<HTMLElement>(ITEMS)?.focus();
    const onDown = (e: MouseEvent) => {
      const at = e.target as Node;
      if (!menuRef.current?.contains(at) && !anchorRef.current?.contains(at)) close.current(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close.current(true);
      } else if (e.key === 'Tab') close.current(false);
    };
    window.addEventListener('mousedown', onDown);
    // A real key press bubbles through both; a script may dispatch on either one.
    document.addEventListener('keydown', onKey);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', measure);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>(ITEMS)];
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    e.preventDefault();
    items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  };

  const style: CSSProperties = place ? { left: place.left, top: place.top, maxHeight: place.maxHeight } : { left: 0, top: 0, visibility: 'hidden' };
  return createPortal(
    <div ref={menuRef} className={`ck-menu ck-menu--float ${className}`.trim()} role="menu" aria-label={label} style={style} onKeyDown={onMenuKey} data-up={place?.up ? 'true' : undefined}>
      {children}
    </div>,
    document.querySelector('.cockpit') ?? document.body,
  );
}
