// A small ring in the message box footer: how full the conversation window is. Click it (or press Enter) for the
// numbers. Drawn only when the agent reported its window size, never guessed. Generic: it takes a reading.
import { t } from '../../i18n';
import { useEffect, useId, useRef, useState } from 'react';
import { formatTokens, type ContextReading } from '../cockpit/rail/railFormat';
import '../../styles/chat-input-card.css';
import { useDismissable } from '../../hooks/useDismissable';

/** Circle of radius 8 in a 20 box. */
const CIRCUMFERENCE = 2 * Math.PI * 8;

export function ContextMeter({ reading }: { reading: ContextReading | null }) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) pop.current?.focus();
  }, [open]);
  // Escape is handled on the popover itself (it returns the focus to the ring and stops the event).
  useDismissable(open, { inside: [root], anchor: root, ignore: ['escape'], onDismiss: () => setOpen(false) });

  if (!reading) return null;
  const { percent, used, window: size } = reading;
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  return (
    <div ref={root} className="ck-menu-rel ck-ctx" data-testid="context-meter">
      <button
        ref={button}
        type="button"
        className="ck-ctx-ring"
        aria-label={t('r11.ctx.aria', { percent })}
        title={t('r11.ctx.aria', { percent })}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? `${uid}-pop` : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
          <circle className="ck-ctx-bg" cx="10" cy="10" r="8" />
          <circle className="ck-ctx-fg" cx="10" cy="10" r="8" strokeDasharray={CIRCUMFERENCE} strokeDashoffset={CIRCUMFERENCE * (1 - percent / 100)} />
        </svg>
      </button>
      {open && (
        <div
          ref={pop}
          id={`${uid}-pop`}
          className="ck-pop ck-pop--right ck-ctx-pop"
          role="dialog"
          tabIndex={-1}
          aria-label={t('r9.ctx.label')}
          data-testid="context-meter-pop"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              close();
            }
          }}
        >
          <div className="ck-ctx-head">
            <span>{t('r9.ctx.title')}</span>
            <span className="ck-ctx-pct">{t('r9.ctx.pct', { n: percent })}</span>
          </div>
          <div className="ck-ctx-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={t('r9.ctx.label')}>
            <i style={{ width: `${percent}%` }} />
          </div>
          <p className="ck-ctx-line">
            {t('r9.ctx.line', { used: formatTokens(used), size: formatTokens(size) })}
          </p>
        </div>
      )}
    </div>
  );
}
