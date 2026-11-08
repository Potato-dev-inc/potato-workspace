// A small ring in the message box footer: how full the conversation window is. Click it (or press Enter) for the
// numbers. Drawn only when the agent reported its window size, never guessed. Generic: it takes a reading.
import { useEffect, useId, useRef, useState } from 'react';
import { formatTokens, type ContextReading } from '../cockpit/rail/railFormat';
import '../../styles/chat-input-card.css';

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
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);

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
        aria-label={`Context ${percent}% used`}
        title={`Context ${percent}% used`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? `${uid}-pop` : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
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
          aria-label="Context used"
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
            <span>Context</span>
            <span className="ck-ctx-pct">{percent}% used</span>
          </div>
          <div className="ck-ctx-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label="Context used">
            <i style={{ width: `${percent}%` }} />
          </div>
          <p className="ck-ctx-line">
            Used {formatTokens(used)} of {formatTokens(size)} tokens
          </p>
        </div>
      )}
    </div>
  );
}
