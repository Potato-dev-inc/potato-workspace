// The header of one pane in the details column: [‹ Back] [logo] title [state] ... [bin] [fold] [fill] [collapse] [close].
// Back opens the full Background tasks page. A double-click on the header folds the pane to this line (when others are open).
import type { ReactNode } from 'react';
import { useT } from '../../../i18n';

const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d={d} />
  </svg>
);

export function TaskHeader({
  title,
  logo,
  state,
  onBack,
  full,
  onFull,
  onClose,
  extra,
  onCollapse,
  folded,
  onFold,
}: {
  title: string;
  logo?: ReactNode;
  /** One short word for what it is doing now ("Working"). */
  state?: string;
  /** Present on a view that has a page behind it (a minion's view); the page itself has no Back. */
  onBack?: () => void;
  full: boolean;
  onFull: () => void;
  onClose: () => void;
  /** Buttons before the fill and close buttons (the page's bin). */
  extra?: ReactNode;
  /** Folds the whole column to its strip. Only the top pane has it, and not while the column fills the window. */
  onCollapse?: () => void;
  /** This pane is folded to its header line. */
  folded?: boolean;
  /** Present when another pane is open: folds or opens this one. */
  onFold?: () => void;
}) {
  const t = useT();
  return (
    <header className="tk-head" onDoubleClick={onFold} data-folded={folded ? 'true' : undefined}>
      {onBack && (
        <button type="button" className="tk-btn tk-back" onClick={onBack} aria-label={t('task.back')} title={t('task.back')}>
          <Icon d="M10 3 5 8l5 5" />
          <span>{t('task.back')}</span>
        </button>
      )}
      {logo}
      <span className="tk-title" title={title}>
        {title}
      </span>
      {state && <span className="tk-state">{state}</span>}
      {extra}
      {onFold && (
        <button type="button" className="tk-btn tk-icon" onClick={onFold} aria-expanded={!folded} aria-label={folded ? t('dock.unfold') : t('dock.fold')} title={folded ? t('dock.unfold') : t('dock.fold')}>
          <Icon d={folded ? 'M4.5 6.5 8 10l3.5-3.5' : 'M4.5 9.5 8 6l3.5 3.5'} />
        </button>
      )}
      <button type="button" className="tk-btn tk-icon" onClick={onFull} aria-pressed={full} aria-label={full ? t('task.unfill') : t('task.fill')} title={full ? t('task.unfill') : t('task.fill')}>
        {full ? <Icon d="M3 6.5h3.5V3M13 6.5H9.5V3M3 9.5h3.5V13M13 9.5H9.5V13" /> : <Icon d="M9.5 3H13v3.5M6.5 13H3V9.5M13 3 9 7M3 13l4-4" />}
      </button>
      {onCollapse && !full && (
        <button type="button" className="tk-btn tk-icon" onClick={onCollapse} aria-label={t('dock.collapse')} title={t('dock.collapse')}>
          <Icon d="M6 3.5 10.5 8 6 12.5" />
        </button>
      )}
      <button type="button" className="tk-btn tk-icon" onClick={onClose} aria-label={t('task.close')} title={t('task.close')}>
        <Icon d="m4 4 8 8M12 4l-8 8" />
      </button>
    </header>
  );
}
