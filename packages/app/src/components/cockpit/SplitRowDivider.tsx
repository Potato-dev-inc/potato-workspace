// The divider between two chats stacked in one split column. Drag it to resize (each chat keeps its minimum
// height), double-click to go back to an even split, or focus it and press Up or Down to move it one step.
import { useRef, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import { SPLIT_ROW_DEFAULT, SPLIT_ROW_DIVIDER_PX, SPLIT_ROW_KEY_STEP_PX, nudgeRows, rowsFromTopPx } from './split-grid';

export function SplitRowDivider({
  colRef,
  rows,
  onRows,
  label,
}: {
  /** The column both chats sit in. Its height is the room they share (with the divider). */
  colRef: RefObject<HTMLDivElement | null>;
  /** The top chat's share of the column's height. */
  rows: number;
  onRows: (rows: number) => void;
  label: string;
}) {
  const dragging = useRef(false);
  const span = () => (colRef.current ? colRef.current.getBoundingClientRect().height - SPLIT_ROW_DIVIDER_PX : 0);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    onRows(nudgeRows(rows, e.key === 'ArrowUp' ? -SPLIT_ROW_KEY_STEP_PX : SPLIT_ROW_KEY_STEP_PX, span()));
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    dragging.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.preventDefault();
    e.currentTarget.focus({ preventScroll: true });
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const col = colRef.current;
    if (!dragging.current || !col) return;
    const rect = col.getBoundingClientRect();
    onRows(rowsFromTopPx(e.clientY - rect.top - SPLIT_ROW_DIVIDER_PX / 2, rect.height - SPLIT_ROW_DIVIDER_PX));
  };
  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    dragging.current = false;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  return (
    <div
      className="ck-split-rowdivider"
      role="separator"
      tabIndex={0}
      aria-orientation="horizontal"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(rows * 100)}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => onRows(SPLIT_ROW_DEFAULT)}
    />
  );
}
