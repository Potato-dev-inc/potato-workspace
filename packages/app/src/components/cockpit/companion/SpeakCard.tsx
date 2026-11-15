// The companion page's card for "speak up first": one switch (off by default) and the most bubbles per hour.
import { useEffect, useId, useState } from 'react';
import { MAX_PER_HOUR, MEMORY_CHANGED_EVENT, mutedKinds, unmuteSaved, useSpeakSettings, type SpeakKind } from '../../../lib/companionSpeak';
import { useT } from '../../../i18n';
import '../../../styles/cockpit-potato-bubble.css';

const CHOICES = Array.from(new Set([1, 2, 3, 4, 6, 8, MAX_PER_HOUR]));

/** The kinds the person said "Too much" to, kept up to date with the saved memory. */
function useMutedKinds(): SpeakKind[] {
  const [kinds, setKinds] = useState<SpeakKind[]>(mutedKinds);
  useEffect(() => {
    const refresh = () => setKinds(mutedKinds());
    window.addEventListener(MEMORY_CHANGED_EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(MEMORY_CHANGED_EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);
  return kinds;
}

export function SpeakCard() {
  const t = useT();
  const [speak, update] = useSpeakSettings();
  const id = useId();
  const muted = useMutedKinds();
  return (
    <section className="ck-companion-card" aria-labelledby={`${id}-title`} data-testid="speak-card">
      <div className="ck-speak-row">
        <h2 className="ck-companion-card-title" id={`${id}-title`}>
          {t('companion.speak.setting.label')}
        </h2>
        <input
          type="checkbox"
          role="switch"
          aria-labelledby={`${id}-title`}
          aria-describedby={`${id}-hint`}
          checked={speak.on}
          onChange={(e) => update({ on: e.target.checked, offered: true })}
        />
      </div>
      <p className="ck-speak-hint" id={`${id}-hint`}>
        {t('companion.speak.setting.hint')}
      </p>
      {speak.on && (
        <div className="ck-speak-row">
          <label htmlFor={`${id}-budget`} className="ck-speak-hint">
            {t('companion.speak.budget.label')}
          </label>
          <select id={`${id}-budget`} aria-describedby={`${id}-budget-hint`} value={speak.perHour} onChange={(e) => update({ perHour: Number(e.target.value) })}>
            {(CHOICES.includes(speak.perHour) ? CHOICES : [...CHOICES, speak.perHour].sort((a, b) => a - b)).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
      )}
      {speak.on && (
        <p className="ck-speak-hint" id={`${id}-budget-hint`}>
          {t('companion.speak.budget.hint')}
        </p>
      )}
      {muted.length > 0 && (
        <ul className="ck-speak-muted" data-testid="speak-muted">
          {muted.map((kind) => (
            <li key={kind} className="ck-speak-row">
              <span className="ck-speak-hint">{t('companion.speak.muted', { kind: t(`companion.speak.kind.${kind}`) })}</span>
              <button type="button" className="ck-btn" onClick={() => unmuteSaved(kind)}>
                {t('companion.speak.unmute')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
