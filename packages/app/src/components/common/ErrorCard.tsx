// ONE error card: What happened / What you can do / one main button. Details are folded away, and "Copy for support" copies
// a short report with folder paths and key-looking text removed. Every error place that has a next step uses this, so a
// person learns the shape once. It never shows a code or a stack unless the person opens Details.
import { useId, useState } from 'react';
import { useT } from '../../i18n';
import { redactReport } from '../../lib/setup-checks/report';
import { useCopy } from '../chat/useCopy';
import '../../styles/error-card.css';

export interface ErrorAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

export interface ErrorCardProps {
  /** One plain sentence: what happened. */
  what: string;
  /** One plain sentence: what the person can do. */
  can: string;
  /** The one main button. Absent: the card only informs. */
  action?: ErrorAction;
  /** Folded under "Details". Redacted before it is shown or copied. */
  details?: string | null;
  /** Who it is about ("Claude"), added to the support report. */
  who?: string | null;
  testId?: string;
  /** Inside a strip or a small notice: tighter spacing. */
  compact?: boolean;
}

/** The text "Copy for support" puts on the clipboard: the three lines, then the details. Redacted. */
export function supportText(parts: { what: string; can: string; details?: string | null; who?: string | null }): string {
  const lines = [`What happened: ${parts.what}`, `What you can do: ${parts.can}`];
  if (parts.who) lines.unshift(`Agent: ${parts.who}`);
  if (parts.details) lines.push('', 'Details:', parts.details);
  return redactReport(lines.join('\n'));
}

/** The folded Details and the Copy for support button: shared by this card and by cards that keep their own layout. */
export function ErrorExtras({ what, can, details, who }: Pick<ErrorCardProps, 'what' | 'can' | 'details' | 'who'>) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const { state, copy } = useCopy();
  const id = useId();
  const shown = details ? redactReport(details) : '';
  return (
    <div className="err-extras">
      {shown && (
        <button type="button" className="err-link" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>
          {open ? t('flow.error.hideDetails') : t('flow.error.showDetails')}
        </button>
      )}
      <button type="button" className="err-link" onClick={() => void copy(supportText({ what, can, details, who }))}>
        {state === 'idle' ? t('flow.error.copy') : t('flow.error.copied')}
      </button>
      {shown && open && (
        <pre id={id} className="err-details">
          {shown}
        </pre>
      )}
    </div>
  );
}

export function ErrorCard({ what, can, action, details, who, testId = 'error-card', compact }: ErrorCardProps) {
  const t = useT();
  return (
    <div className={`err-card${compact ? ' is-compact' : ''}`} role="alert" data-testid={testId}>
      <p className="err-line">
        <span className="err-cap">{t('flow.error.whatHappened')}</span>
        <span className="err-text">{what}</span>
      </p>
      <p className="err-line">
        <span className="err-cap">{t('flow.error.whatToDo')}</span>
        <span className="err-text">{can}</span>
      </p>
      {action && (
        <button type="button" className="ck-btn err-main" disabled={action.disabled} onClick={action.onClick}>
          {action.label}
        </button>
      )}
      <ErrorExtras what={what} can={can} details={details} who={who} />
    </div>
  );
}
