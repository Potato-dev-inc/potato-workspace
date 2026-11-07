import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

/** A "More" menu for the pane's less used views. Its button shows the open view's name. */
export function PaneMoreMenu<T extends string>({
  items,
  value,
  onPick,
  label = 'More',
}: {
  items: { id: T; label: string }[];
  /** The selected view. When it is one of `items`, the button shows its name. */
  value: string;
  onPick: (id: T) => void;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const current = items.find((i) => i.id === value);

  // Opening puts focus on the first item. Escape closes and returns focus to the button; Tab or a click outside closes.
  useEffect(() => {
    if (!open) return;
    wrapRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const close = (returnFocus: boolean) => {
      setOpen(false);
      if (returnFocus) buttonRef.current?.focus();
    };
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) close(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close(true);
      } else if (e.key === 'Tab') close(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Up and Down move between the items, wrapping.
  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
    e.preventDefault();
    items[next]?.focus();
  };

  return (
    <div className="ck-menu-wrap" ref={wrapRef}>
      <button
        ref={buttonRef}
        type="button"
        className="ck-seg-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {current ? current.label : label}
      </button>
      {open && (
        <div className="ck-menu" role="menu" aria-label={label} onKeyDown={onMenuKey}>
          {items.map((i) => (
            <button
              key={i.id}
              type="button"
              role="menuitem"
              className="ck-menu-item"
              onClick={() => {
                setOpen(false);
                onPick(i.id);
                buttonRef.current?.focus();
              }}
            >
              {i.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
