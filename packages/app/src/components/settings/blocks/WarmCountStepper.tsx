// "keep N warm" for one agent: a small number field with − and + (1 to 10). Typing is allowed; a number outside the
// range is put back inside it with a plain hint. Above 4, a line says each warm agent uses memory.
import { useEffect, useRef, useState } from 'react';
import { useT } from '../../../i18n';
import { MAX_WARM_PER_PROVIDER, WARM_MEMORY_WARN_ABOVE } from '../../../lib/standby';

export function WarmCountStepper({ label, value, disabled, onChange }: { label: string; value: number; disabled?: boolean; onChange: (next: number) => void }) {
  const t = useT();
  const [draft, setDraft] = useState(String(value));
  const [hint, setHint] = useState(false);
  const typing = useRef(false);
  useEffect(() => {
    if (!typing.current) setDraft(String(value));
  }, [value]);

  const commit = (raw: number, fromTyping: boolean) => {
    const clamped = Math.min(MAX_WARM_PER_PROVIDER, Math.max(1, Math.round(raw)));
    setHint(fromTyping && clamped !== Math.round(raw));
    typing.current = false;
    setDraft(String(clamped));
    if (clamped !== value) onChange(clamped);
  };
  const finishTyping = () => {
    const parsed = Number(draft);
    if (draft.trim() === '' || !Number.isFinite(parsed)) {
      typing.current = false;
      setDraft(String(value));
      return;
    }
    commit(parsed, true);
  };

  const shown = Number.isFinite(Number(draft)) && draft.trim() !== '' ? Number(draft) : value;
  return (
    <span className="st-warm-stepper" data-testid="warm-stepper">
      <button type="button" className="st-btn is-small st-warm-btn" aria-label={t('preload.warmLess', { label })} disabled={disabled || value <= 1} onClick={() => commit(value - 1, false)}>
        −
      </button>
      <input
        type="number"
        inputMode="numeric"
        className="st-field is-mono is-number st-warm-input"
        aria-label={t('preload.warmCount', { label })}
        min={1}
        max={MAX_WARM_PER_PROVIDER}
        disabled={disabled}
        value={draft}
        onChange={(event) => {
          typing.current = true;
          setDraft(event.target.value);
        }}
        onBlur={finishTyping}
        onKeyDown={(event) => {
          if (event.key === 'Enter') finishTyping();
        }}
      />
      <button type="button" className="st-btn is-small st-warm-btn" aria-label={t('preload.warmMore', { label })} disabled={disabled || value >= MAX_WARM_PER_PROVIDER} onClick={() => commit(value + 1, false)}>
        +
      </button>
      {hint && (
        <small className="st-warm-note" role="status">
          {t('preload.warmRange', { max: MAX_WARM_PER_PROVIDER })}
        </small>
      )}
      {shown > WARM_MEMORY_WARN_ABOVE && !disabled && (
        <small className="st-warm-note" role="note">
          {t('preload.warmMemory')}
        </small>
      )}
    </span>
  );
}
