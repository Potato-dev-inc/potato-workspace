import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';

export interface SegOption<T extends string> {
  id: T;
  label: string;
  /** A small dim number after the label (files changed). */
  badge?: number;
}

/** Segmented control with a sliding active pill (CSS transition only). */
export function SegTabs<T extends string>({
  options,
  value,
  onChange,
  label,
  small,
}: {
  options: SegOption<T>[];
  value: T;
  onChange: (id: T) => void;
  label: string;
  small?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [pill, setPill] = useState<{ left: number; width: number } | null>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => {
      const el = root.querySelector<HTMLElement>('[aria-selected="true"]');
      // No selected segment (a view opened from outside the row, such as More): no pill.
      setPill(el ? { left: el.offsetLeft, width: el.offsetWidth } : null);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    return () => ro.disconnect();
  }, [value, options.length]);

  // Roving tabindex: one tab stop, on the selected segment (or the first when none is selected).
  const selectedIx = options.findIndex((o) => o.id === value);
  const stopIx = selectedIx < 0 ? 0 : selectedIx;

  // Left/Right move between segments (wrapping), Home/End jump to the ends. Moving also selects, as a click does.
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, ix: number) => {
    const n = options.length;
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = (ix + 1) % n;
    else if (e.key === 'ArrowLeft') next = (ix - 1 + n) % n;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    if (next === null) return;
    e.preventDefault();
    const btns = rootRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    btns?.[next]?.focus();
    onChange(options[next].id);
  };

  return (
    <div ref={rootRef} className={`ck-seg${small ? ' ck-seg--sm' : ''}`} role="tablist" aria-label={label}>
      {pill && <span className="ck-seg-pill" style={{ transform: `translateX(${pill.left}px)`, width: pill.width }} />}
      {options.map((o, ix) => (
        <button
          key={o.id}
          type="button"
          role="tab"
          aria-selected={o.id === value}
          tabIndex={ix === stopIx ? 0 : -1}
          className="ck-seg-btn"
          onClick={() => onChange(o.id)}
          onKeyDown={(e) => onKeyDown(e, ix)}
        >
          {o.label}
          {o.badge !== undefined && <span className="ck-seg-badge">{o.badge}</span>}
        </button>
      ))}
    </div>
  );
}
