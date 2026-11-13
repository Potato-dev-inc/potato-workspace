// A thin handle on the edge of a panel (the sidebar, the right panel). Drag it, focus it and press Left / Right,
// Home / End, or double-click to go back to the normal width. Same pointer handling as SplitDivider.
// `grow` says which way makes the panel wider: `right` when the panel is to the left of the handle (the sidebar),
// `left` when it is to the right (the right panel).
import { useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { KEY_STEP } from '../../lib/panel-widths';
import '../../styles/cockpit-resize.css';

export function ResizeHandle({
  value,
  min,
  max,
  grow,
  label,
  title,
  className = '',
  onChange,
  onCommit,
  onReset,
}: {
  /** The panel's width now, in px. */
  value: number;
  min: number;
  max: number;
  grow: 'left' | 'right';
  label: string;
  title?: string;
  className?: string;
  /** The edge moved: the new width in px. Not limited: the caller decides (for example, snapping to a strip). */
  onChange: (px: number) => void;
  /** The move is over (pointer up or a key): remember it. */
  onCommit: () => void;
  onReset: () => void;
}) {
  const drag = useRef<{ x: number; start: number } | null>(null);
  const sign = grow === 'right' ? 1 : -1;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    let next: number | null = null;
    if (e.key === 'ArrowLeft') next = value + sign * -KEY_STEP;
    else if (e.key === 'ArrowRight') next = value + sign * KEY_STEP;
    else if (e.key === 'Home') next = min;
    else if (e.key === 'End') next = max;
    if (next === null) return;
    e.preventDefault();
    onChange(next);
    onCommit();
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    drag.current = { x: e.clientX, start: value };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    // A drag selects no text; the handle takes focus so the arrows work right after.
    e.preventDefault();
    e.currentTarget.focus({ preventScroll: true });
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    onChange(d.start + sign * (e.clientX - d.x));
  };
  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    onCommit();
  };

  return (
    <div
      className={`ck-resize ${className}`.trim()}
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value)}
      title={title}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onReset}
    />
  );
}
