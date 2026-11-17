// The draggable line between two stacked panes of the dock. Drag it, or focus it and press Up / Down. It tells the dock where
// the upper pane's bottom edge is now (in px, measured from the upper pane's top); the dock turns that into weights
// (`moveSplit` in lib/panel-widths) so the two panes keep their shared height and neither goes under the minimum.
import { useRef, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import { useT } from '../../../i18n';
import { DOCK_PANE_MIN, KEY_STEP } from '../../../lib/panel-widths';

export function DockSplitter({
  upper,
  lower,
  onMove,
  onCommit,
}: {
  upper: RefObject<HTMLElement | null>;
  lower: RefObject<HTMLElement | null>;
  /** The upper pane should now be `topPx` high, of `pairPx` for both. */
  onMove: (topPx: number, pairPx: number) => void;
  onCommit: () => void;
}) {
  const t = useT();
  const drag = useRef<{ y: number; top: number; pair: number } | null>(null);
  const sizes = () => {
    const top = upper.current?.getBoundingClientRect().height ?? 0;
    const bottom = lower.current?.getBoundingClientRect().height ?? 0;
    return { top, pair: top + bottom };
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const { top, pair } = sizes();
    let next: number | null = null;
    if (e.key === 'ArrowUp') next = top - KEY_STEP;
    else if (e.key === 'ArrowDown') next = top + KEY_STEP;
    else if (e.key === 'Home') next = DOCK_PANE_MIN;
    else if (e.key === 'End') next = pair - DOCK_PANE_MIN;
    if (next === null) return;
    e.preventDefault();
    onMove(next, pair);
    onCommit();
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const { top, pair } = sizes();
    drag.current = { y: e.clientY, top, pair };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.preventDefault();
    e.currentTarget.focus({ preventScroll: true });
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d) onMove(d.top + (e.clientY - d.y), d.pair);
  };
  const end = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    onCommit();
  };
  return (
    <div
      className="tk-split"
      role="separator"
      tabIndex={0}
      aria-orientation="horizontal"
      aria-label={t('dock.split')}
      title={t('dock.splitTip')}
      data-testid="dock-splitter"
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
    />
  );
}
