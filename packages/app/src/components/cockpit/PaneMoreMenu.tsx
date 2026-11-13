import { useRef, useState } from 'react';
import { useT } from '../../i18n';
import { FloatingMenu } from './FloatingMenu';

/** Space kept between the menu and the window edge (px). */
export const MENU_EDGE_GAP = 8;

/** How far to slide a menu sideways so it sits inside [gap, viewport - gap]. Pure; 0 when it already fits. */
export function menuShiftX(left: number, right: number, viewport: number, gap = MENU_EDGE_GAP): number {
  if (right - left > viewport - 2 * gap) return gap - left;
  if (right > viewport - gap) return viewport - gap - right;
  if (left < gap) return gap - left;
  return 0;
}

/** An action folded out of the pane header when there is no room for it there. */
export interface MoreAction {
  id: string;
  label: string;
  title?: string;
  disabled?: boolean;
  onSelect: () => void;
}

/** A "More" menu for the pane's less used views and for the header actions that do not fit: a ⋯ button; it is lit while one of its views is open.
 *  The menu is drawn in the top layer (FloatingMenu), so the pane or the right rail never clips it. */
export function PaneMoreMenu<T extends string>({
  items,
  actions = [],
  value,
  onPick,
  label: labelProp,
}: {
  items: { id: T; label: string }[];
  /** Header actions that moved in here because the header is narrow. */
  actions?: MoreAction[];
  /** The selected view. When it is one of `items`, the button shows its name. */
  value: string;
  onPick: (id: T) => void;
  label?: string;
}) {
  const t = useT();
  const label = labelProp ?? t('pane.more');
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const current = items.find((i) => i.id === value);
  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  };

  return (
    <div className="ck-menu-wrap">
      <button
        ref={buttonRef}
        type="button"
        className={`ck-icon-btn ck-more-btn${current ? ' is-on' : ''}`}
        aria-label={label}
        title={current ? `${label} · ${current.label}` : label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden="true">{'⋯'}</span>
      </button>
      {open && (
        <FloatingMenu anchorRef={buttonRef} onClose={close} label={label} align="end">
          {items.map((i) => (
            <button
              key={i.id}
              type="button"
              role="menuitem"
              className="ck-menu-item"
              onClick={() => {
                close(true);
                onPick(i.id);
              }}
            >
              {i.label}
            </button>
          ))}
          {actions.length > 0 && <div className="ck-menu-sep" role="separator" />}
          {actions.map((a) => (
            <button
              key={a.id}
              type="button"
              role="menuitem"
              className="ck-menu-item"
              title={a.title}
              disabled={a.disabled}
              onClick={() => {
                close(false);
                a.onSelect();
              }}
            >
              {a.label}
            </button>
          ))}
        </FloatingMenu>
      )}
    </div>
  );
}
