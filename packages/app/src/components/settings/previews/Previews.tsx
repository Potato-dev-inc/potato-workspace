// Small frames drawn under a row's control: the mode switch animation, a sample usage bar, and the "Send a test"
// button. Grey only. Nothing here saves anything.
import { useEffect, useRef, useState } from 'react';
import { errorSentence } from '../../../lib/sayError';
import { motionFor, parseSwitchStyle, prefersReducedMotion, type SwitchStyle } from '../../../lib/mode-switch/model';
import { Btn } from '../settings-ui';

/**
 * A 120 x 72 frame that plays the chosen animation once when the choice changes, and again on "Play". With
 * reduced motion it never moves: it stays still and Play does nothing visible.
 */
export function ModeSwitchFrame({ style }: { style: SwitchStyle | string | undefined }) {
  const chosen = parseSwitchStyle(style);
  const [run, setRun] = useState(0);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setRun((n) => n + 1);
  }, [chosen]);
  const motion = motionFor(chosen, false);
  const moving = run > 0 && !prefersReducedMotion();
  return (
    <div className="st-preview st-mode-preview">
      {/* The picture is the play button: hover shows a small triangle. */}
      <button type="button" className="st-mode-frame" aria-label="Play the animation" data-motion={motion} data-playing={moving ? motion : undefined} key={run} onClick={() => setRun((n) => n + 1)}>
        <i />
        <i />
        <i />
        <span className="st-mode-play" aria-hidden="true">
          ▶
        </span>
      </button>
    </div>
  );
}

/** A sample usage bar with fixed numbers, labelled "Example". The row draws it only while its switch is on. */
export function UsageSample() {
  return (
    <div className="st-preview st-usage-sample" aria-label="Example of the usage bar">
      <span className="st-usage-tag">Example</span>
      {[
        ['Claude', 62],
        ['Codex', 18],
      ].map(([name, used]) => (
        <div key={name} className="st-usage-line">
          <span>{name}</span>
          <span className="st-usage-track">
            <i style={{ width: `${used}%` }} />
          </span>
          <span className="st-usage-num">{used}%</span>
        </div>
      ))}
    </div>
  );
}

export interface TestResult {
  ok: boolean;
  message: string;
}

/**
 * "Send a test": posts one test alert and shows the result as one line ("Sent", or the plain error). With nothing
 * to send to it is disabled, and says why in words next to it.
 */
export function SendTest({ disabledReason, send }: { disabledReason?: string | null; send?: () => Promise<TestResult> }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const blocked = Boolean(disabledReason) || !send;
  const run = async () => {
    if (!send) return;
    setBusy(true);
    setResult(null);
    try {
      setResult(await send());
    } catch (error) {
      setResult({ ok: false, message: errorSentence(error) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="st-sendtest">
      <Btn small disabled={blocked || busy} onClick={() => void run()}>
        Send a test
      </Btn>
      {disabledReason && <small className="st-sendtest-why">{disabledReason}</small>}
      {result && (
        <small className="st-sendtest-line" role={result.ok ? 'status' : 'alert'}>
          {result.message}
        </small>
      )}
    </span>
  );
}
