// The "Pinned" group at the top of the sidebar. Its chats can be dragged into a new order, and a chat dragged
// here from anywhere in the list is pinned at that place. While a chat is being dragged and nothing is pinned yet,
// an empty drop box shows, so the first pin can be made by dragging too.
import type { ReactNode } from 'react';
import { useT } from '../../i18n';
import { useDrag } from '../dnd/dragStore';
import { ReorderList } from '../dnd/ReorderList';
import { chatItems, rowIdOf } from './sidebar-reorder';

export function PinnedGroup({
  ids,
  canPin,
  onPlace,
  labelOf,
  children,
}: {
  /** The pinned chats on screen, in order. */
  ids: readonly string[];
  /** Whether a chat can be pinned by dropping it here (top-level chats only: helpers move with their parent). */
  canPin: (id: string) => boolean;
  /** Pin (or move) a chat to a slot among the pinned ones on screen. */
  onPlace: (id: string, slot: number, visible: string[]) => void;
  labelOf: (id: string) => string;
  children: ReactNode;
}) {
  const t = useT();
  const drag = useDrag();
  const dragging = drag?.payload.kind === 'chat';
  if (ids.length === 0 && !dragging) return null;
  return (
    <ReorderList
      zoneId="sidebar-pinned"
      kind="chat"
      axis="y"
      className={`ck-group ck-pinned${ids.length === 0 ? ' ck-pinned--empty' : ''}`}
      priority={1}
      // Empty: the drop box floats over the list (no height of its own), so nothing moves when a drag starts.
      hitBox={(box) => (ids.length === 0 ? box.querySelector('.ck-pin-drop') : null)}
      accepts={(p) => canPin(p.id)}
      items={(box) => chatItems(box, ids)}
      keyboardId={(el) => {
        const id = rowIdOf(el);
        return id !== null && ids.includes(id) ? id : null;
      }}
      label={labelOf}
      onMove={(id, slot, visible) => onPlace(id, slot, visible)}
    >
      {ids.length > 0 && <div className="ck-caption">{t('sidebar.pinned')}</div>}
      {children}
      {ids.length === 0 && <div className={`ck-pin-drop${drag?.over === 'sidebar-pinned' ? ' is-over' : ''}`}>{t('dnd.pinHere')}</div>}
    </ReorderList>
  );
}
