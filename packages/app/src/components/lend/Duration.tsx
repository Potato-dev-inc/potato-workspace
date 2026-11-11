import { useState } from 'react';
import { customSecs, durationProblem, durationWords, PRESETS } from '../../lib/lend';
import '../../styles/lend.css';

/**
 * How long: 1 hour, 8 hours, 24 hours, or Custom (hours and minutes). A length over the cap is shown as a
 * sentence and the caller blocks it too (`durationProblem`): 7 days, or 24 hours for another person.
 */
export function DurationField({
  secs,
  onChange,
  forOther,
  label = 'How long',
  maxSecs,
}: {
  secs: number;
  onChange: (secs: number) => void;
  forOther: boolean;
  label?: string;
  /** A tighter cap than the general one (a profile's own limit). */
  maxSecs?: number;
}) {
  const isPreset = PRESETS.some((p) => p.secs === secs);
  const [custom, setCustom] = useState(!isPreset);
  const [hours, setHours] = useState(String(Math.floor(secs / 3600)));
  const [minutes, setMinutes] = useState(String(Math.floor((secs % 3600) / 60)));
  const general = durationProblem(secs, forOther);
  const problem = general ?? (maxSecs !== undefined && secs > maxSecs ? `The most here is ${durationWords(maxSecs)}.` : null);

  const type = (h: string, m: string) => {
    setHours(h);
    setMinutes(m);
    onChange(customSecs(h, m));
  };

  return (
    <fieldset className="lend-dur">
      <legend className="lend-legend">{label}</legend>
      <div className="lend-seg">
        {PRESETS.map((p) => (
          <button
            key={p.secs}
            type="button"
            aria-pressed={!custom && secs === p.secs}
            onClick={() => {
              setCustom(false);
              onChange(p.secs);
            }}
          >
            {p.label}
          </button>
        ))}
        <button type="button" aria-pressed={custom} onClick={() => setCustom(true)}>
          Custom
        </button>
      </div>
      {custom && (
        <div className="lend-row">
          <input className="lend-num" type="number" min={0} inputMode="numeric" aria-label="Hours" value={hours} onChange={(e) => type(e.target.value, minutes)} />
          <span>hours</span>
          <input className="lend-num" type="number" min={0} max={59} inputMode="numeric" aria-label="Minutes" value={minutes} onChange={(e) => type(hours, e.target.value)} />
          <span>minutes</span>
        </div>
      )}
      {problem && (
        <p className="lend-problem" role="alert">
          {problem}
        </p>
      )}
    </fieldset>
  );
}

/** True when the length can be used. */
export const durationOk = (secs: number, forOther: boolean, maxSecs?: number): boolean =>
  durationProblem(secs, forOther) === null && (maxSecs === undefined || secs <= maxSecs);
