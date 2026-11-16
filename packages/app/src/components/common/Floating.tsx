// The ONE floating layer: <Popover> (a card: warning, form, list) and <Menu> (a list of actions). Both
//   - draw into the app's top layer (a portal into the cockpit root, position: fixed, z-index 1000), so no pane, rail or card
//     with overflow can clip them and no sibling layer covers them;
//   - sit at their anchor (a button, or a point such as a right-click) through `placeFloating`: under it, above when there is
//     no room, slid back inside the window;
//   - close through `useDismissable` (outside press, focus leaving, window blur, page scroll) and Escape;
//   - know their children: a Popover or Menu opened from inside another one registers with it, so a press inside the child
//     is never "outside" the parent, and Escape closes the innermost one first;
//   - give the focus back to the anchor after Escape.
// A Menu also focuses its first item, moves with Up/Down, and closes on Tab.
import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEventHandler,
  type MouseEventHandler,
  type PointerEventHandler,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { useDismissable } from '../../hooks/useDismissable';
import '../../styles/floating.css';

/** Space kept between the layer and the window edge (px). */
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
  /** True when the layer opened above its anchor. */
  up: boolean;
}

/** Where the layer goes. Pure. `align` says which edge of the anchor it lines up with; `prefer` is the side it tries first. */
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

/** A layer open inside another: the parent counts the child's element as inside. */
interface Layer {
  register: (el: HTMLElement) => () => void;
}
const LayerContext = createContext<Layer | null>(null);

/**
 * For a hand-made card that holds shared layers (a Popover or Menu opened from inside it): `extra` goes into its
 * `useDismissable` so a press in the child is not "outside", `busy()` says a child is open (Escape belongs to the child),
 * and `wrap` puts the card's children inside the layer tree.
 */
export function useLayerHost() {
  const parent = useContext(LayerContext);
  const kids = useRef(new Set<HTMLElement>());
  const layer = useMemo<Layer>(
    () => ({
      // A grandchild counts as inside every layer above it.
      register: (el) => {
        kids.current.add(el);
        const up = parent?.register(el);
        return () => {
          kids.current.delete(el);
          up?.();
        };
      },
    }),
    [parent],
  );
  const extra = useRef(() => [...kids.current]).current;
  const busy = () => kids.current.size > 0;
  const wrap = (children: ReactNode) => <LayerContext.Provider value={layer}>{children}</LayerContext.Provider>;
  return { layer, kids, extra, busy, wrap };
}

const ITEMS = '[role^="menuitem"]:not(:disabled), [role="radio"]:not(:disabled)';

export interface FloatProps {
  /** The button that opened it. Give this or `point`. */
  anchorRef?: RefObject<HTMLElement | null>;
  /** A window position (a right-click) when there is no button. */
  point?: { x: number; y: number };
  /** Called when it should close; `returnFocus` is true after Escape (the anchor already has the focus then). */
  onClose: (returnFocus: boolean) => void;
  align?: 'start' | 'end';
  prefer?: 'down' | 'up';
  className?: string;
  label?: string;
  testId?: string;
  id?: string;
  /** What the layer is for. A Popover defaults to a dialog; a Menu is always `menu`. */
  role?: 'dialog' | 'listbox' | 'menu' | 'group';
  /** `form` makes the layer itself the form (a card that submits on Enter). */
  as?: 'div' | 'form';
  onSubmit?: FormEventHandler<HTMLElement>;
  /** Stops a press inside the layer from reaching a drag or pointer handler of the parent (the React tree still bubbles). */
  onPointerDown?: PointerEventHandler<HTMLElement>;
  onContextMenu?: MouseEventHandler<HTMLElement>;
  /** Smallest width and tallest height (px), for lists. */
  minWidth?: number;
  maxHeight?: number;
  style?: CSSProperties;
  children: ReactNode;
}

function Float({ menu, role, as = 'div', ...p }: FloatProps & { menu: boolean }) {
  const parent = useContext(LayerContext);
  const ref = useRef<HTMLElement | null>(null);
  // One stable callback: a new one each render would clear the element before a child (autoFocus) takes the focus.
  const setRef = useRef((el: HTMLElement | null) => {
    ref.current = el;
  }).current;
  const [place, setPlace] = useState<FloatPlace | null>(null);
  const close = useRef(p.onClose);
  close.current = p.onClose;
  const { layer, kids, extra } = useLayerHost();
  useLayoutEffect(() => (ref.current && parent ? parent.register(ref.current) : undefined), [parent]);

  const measure = () => {
    const el = ref.current;
    if (!el) return;
    const r = p.anchorRef?.current?.getBoundingClientRect();
    const box: Box | null = r ?? (p.point ? { left: p.point.x, right: p.point.x, top: p.point.y, bottom: p.point.y } : null);
    if (!box) return;
    const size = { width: el.offsetWidth, height: el.scrollHeight };
    setPlace(placeFloating(box, size, { width: window.innerWidth, height: window.innerHeight }, p.align ?? (menu ? 'end' : 'start'), p.prefer ?? 'down'));
  };
  useLayoutEffect(measure, [p.align, p.prefer, p.point?.x, p.point?.y, p.children]);

  const self = ref as RefObject<Element | null>;
  useDismissable(true, {
    inside: p.anchorRef ? [self, p.anchorRef] : [self],
    extra,
    anchor: p.anchorRef ?? self,
    ignore: ['escape'],
    onDismiss: () => close.current(false),
  });

  useEffect(() => {
    if (menu) ref.current?.querySelector<HTMLElement>(ITEMS)?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        // An open child answers first; this layer closes on the next press.
        if (kids.current.size > 0) return;
        e.stopPropagation();
        p.anchorRef?.current?.focus();
        close.current(true);
      } else if (e.key === 'Tab' && menu) close.current(false);
    };
    // A real key press bubbles through both; a script may dispatch on either one.
    document.addEventListener('keydown', onKey);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', measure);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', measure);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (!menu || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>(ITEMS)];
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    e.preventDefault();
    items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  };

  const style: CSSProperties = {
    ...p.style,
    ...(p.minWidth ? { minWidth: p.minWidth } : null),
    ...(place ? { left: place.left, top: place.top, maxHeight: p.maxHeight ? Math.min(place.maxHeight, p.maxHeight) : place.maxHeight } : { left: 0, top: 0, visibility: 'hidden' }),
  };
  const cls = ['fl-layer', menu ? 'ck-menu ck-menu--float' : '', p.className ?? ''].filter(Boolean).join(' ');
  const node = createElement(
    as,
    {
      ref: setRef,
      id: p.id,
      className: cls,
      role: menu ? 'menu' : role,
      'aria-label': p.label,
      'data-testid': p.testId,
      'data-up': place?.up ? 'true' : undefined,
      style,
      onKeyDown,
      onSubmit: p.onSubmit,
      onPointerDown: p.onPointerDown,
      onContextMenu: p.onContextMenu,
    },
    <LayerContext.Provider value={layer}>{p.children}</LayerContext.Provider>,
  );
  return createPortal(node, document.querySelector('.cockpit, .pwa-shell') ?? document.body);
}

/** A card in the top layer: a warning, a form, a list. Role `dialog` unless told. */
export function Popover(props: FloatProps) {
  return <Float {...props} menu={false} role={props.role ?? 'dialog'} />;
}

/** A list of actions in the top layer. Items are `role="menuitem"` (or `menuitemradio`) buttons. */
export function Menu(props: Omit<FloatProps, 'role' | 'as' | 'onSubmit'>) {
  return <Float {...props} menu role="menu" />;
}
