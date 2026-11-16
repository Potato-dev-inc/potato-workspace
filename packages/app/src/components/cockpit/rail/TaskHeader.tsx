// The header of the details column: [‹ Back] [logo] title … [bin] [fill] [close]. Back opens the full Background tasks page.
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
  onBack,
  full,
  onFull,
  onClose,
  extra,
}: {
  title: string;
  logo?: ReactNode;
  /** Present on a view that has a page behind it (a minion's view); the page itself has no Back. */
  onBack?: () => void;
  full: boolean;
  onFull: () => void;
  onClose: () => void;
  /** Buttons before the fill and close buttons (the page's bin). */
  extra?: ReactNode;
}) {
  const t = useT();
  return (
    <header className="tk-head">
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
      {extra}
      <button type="button" className="tk-btn tk-icon" onClick={onFull} aria-pressed={full} aria-label={full ? t('task.unfill') : t('task.fill')} title={full ? t('task.unfill') : t('task.fill')}>
        {full ? <Icon d="M3 6.5h3.5V3M13 6.5H9.5V3M3 9.5h3.5V13M13 9.5H9.5V13" /> : <Icon d="M9.5 3H13v3.5M6.5 13H3V9.5M13 3 9 7M3 13l4-4" />}
      </button>
      <button type="button" className="tk-btn tk-icon" onClick={onClose} aria-label={t('task.close')} title={t('task.close')}>
        <Icon d="m4 4 8 8M12 4l-8 8" />
      </button>
    </header>
  );
}
