// A box whose children can be dragged into a new order. Wraps the children in a div that registers one drop zone;
// the caller says how to find the items on screen and what to do with the new slot. The thin line is drawn by
// `DragLayer`. Items are found by id each time they are needed, so the list can change while it is dragged over.
import { useEffect, useRef, type HTMLAttributes, type KeyboardEvent, type ReactNode } from 'react';
import { registerDropZone, type DragPayload } from './dragStore';
import { insertIndex, lineForSlot, type Axis, type Box } from './reorder';
import { useT } from '../../i18n';
import { announce } from './announce';

export interface ReorderItem {
  id: string;
  el: Element;
}

export interface ReorderListProps {
  /** Unique among the zones on screen. */
  zoneId: string;
  /** What is dragged (`DragPayload.kind`). */
  kind: string;
  axis: Axis;
  /** The items in their current order, with the element to measure. */
  items: (container: HTMLElement) => ReorderItem[];
  /** Whether this list takes the payload (default: any with the right kind). */
  accepts?: (payload: DragPayload) => boolean;
  /** Dropped: the id and the slot (0..items) among the items, counted before the move. */
  onMove: (id: string, slot: number, itemIds: string[]) => void;
  /**
   * The keyboard way: Alt + the arrow keys of the axis (Up/Down, or Left/Right) on an item moves it one place.
   * Says which item a focused element belongs to (null: not one of ours).
   */
  keyboardId?: (target: Element) => string | null;
  /** The shown name of an item, for the spoken message after a keyboard move. */
  label?: (id: string) => string;
  /** Where the zone is hit, when that is not the wrapping div itself (default: the div). */
  hitBox?: (container: HTMLElement) => Element | null;
  /** Wins over a zone it overlaps (see `DropZone.priority`). */
  priority?: number;
  className?: string;
  /** Extra attributes for the wrapping div (role, aria-label, data-testid ...). */
  attrs?: HTMLAttributes<HTMLDivElement> & { 'data-testid'?: string };
  children: ReactNode;
}

export function ReorderList({ zoneId, kind, axis, items, accepts, onMove, priority, hitBox, keyboardId, label, className, attrs, children }: ReorderListProps) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const live = useRef({ items, accepts, onMove, hitBox });
  live.current = { items, accepts, onMove, hitBox };
  useEffect(() => {
    const measure = (): { ids: string[]; boxes: Box[] } => {
      const el = box.current;
      const found = el ? live.current.items(el) : [];
      return { ids: found.map((f) => f.id), boxes: found.map((f) => f.el.getBoundingClientRect()) };
    };
    return registerDropZone({
      id: zoneId,
      priority,
      accepts: (p) => p.kind === kind && (live.current.accepts?.(p) ?? true),
      getRect: () => {
        const el = box.current;
        return (el ? (live.current.hitBox?.(el) ?? el) : null)?.getBoundingClientRect() ?? null;
      },
      line: (x, y) => {
        const { boxes } = measure();
        return lineForSlot(boxes, axis, insertIndex(boxes, axis, axis === 'x' ? x : y));
      },
      onDrop: (p, pt) => {
        const { ids, boxes } = measure();
        live.current.onMove(p.id, insertIndex(boxes, axis, axis === 'x' ? pt.x : pt.y), ids);
      },
    });
  }, [zoneId, kind, axis, priority]);
  // Alt + arrow on an item: one place up/down (left/right). Focus is put back after the move, and the move is said aloud.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!keyboardId || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const back = axis === 'y' ? 'ArrowUp' : 'ArrowLeft';
    const fwd = axis === 'y' ? 'ArrowDown' : 'ArrowRight';
    if (e.key !== back && e.key !== fwd) return;
    const id = keyboardId(e.target as Element);
    const el = box.current;
    if (id === null || !el) return;
    e.preventDefault();
    e.stopPropagation();
    const ids = items(el).map((i) => i.id);
    const at = ids.indexOf(id);
    if (at === -1) return;
    const slot = e.key === back ? at - 1 : at + 2;
    if (slot < 0 || slot > ids.length) return;
    const target = e.target as HTMLElement;
    onMove(id, slot, ids);
    requestAnimationFrame(() => target.isConnected && target.focus());
    announce(t('dnd.moved', { name: label?.(id) ?? id, n: (e.key === back ? at - 1 : at + 1) + 1, total: ids.length }));
  };
  return (
    <div ref={box} className={className} onKeyDown={onKeyDown} {...attrs}>
      {children}
    </div>
  );
}
