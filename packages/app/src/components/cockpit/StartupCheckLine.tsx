// The quiet start-up check, drawn: nothing while all is fine; one small line with a Fix button when something is wrong. It
// never blocks (no window, no focus grab), can be dismissed with the x, and runs once a few seconds after start.
import { useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n';
import { openSettingsAt } from '../../lib/openSettingsAt';
import { canStartupCheck, runStartupCheck, tauriStartupDeps, type StartupDeps, type StartupFix, type StartupLine } from '../../lib/startup-check';
import '../../styles/startup-check.css';

/** How long after the start the check runs, so it never competes with the window opening. */
export const STARTUP_CHECK_DELAY_MS = 4000;

export interface StartupFixActions {
  signIn: (agentId: string) => void;
}

export function StartupCheckLine({
  deps,
  bridgeUp,
  actions,
  delayMs = STARTUP_CHECK_DELAY_MS,
  enabled = canStartupCheck(),
}: {
  /** Test sources; the app passes none and the real ones are used. */
  deps?: StartupDeps;
  bridgeUp: () => boolean;
  actions: StartupFixActions;
  delayMs?: number;
  enabled?: boolean;
}) {
  const t = useT();
  const [lines, setLines] = useState<StartupLine[]>([]);
  const [hidden, setHidden] = useState(false);
  const bridgeRef = useRef(bridgeUp);
  bridgeRef.current = bridgeUp;

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const timer = window.setTimeout(() => {
      void runStartupCheck(deps ?? tauriStartupDeps(() => bridgeRef.current()))
        .then((found) => alive && setLines(found))
        .catch(() => undefined); // a quiet check never shows its own failure
    }, delayMs);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
    // Once per start: the check does not follow later changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, delayMs]);

  const line = lines[0];
  if (!line || hidden) return null;
  const more = lines.length - 1;
  const fix = (f: StartupFix) => {
    if (f.kind === 'signin' && f.agentId) actions.signIn(f.agentId);
    else if (f.kind === 'terminals') openSettingsAt('agents', 'show-terminals');
    else if (f.kind === 'settings') openSettingsAt(f.page ?? 'overview');
  };
  return (
    <div className="sc-line" role="status" data-testid="startup-check" data-check={line.id}>
      <span className="sc-text">
        {line.text}
        {more > 0 && <span className="sc-more"> {t('flow.startup.more', { count: more })}</span>}
      </span>
      {line.fix && (
        <button type="button" className="sc-fix" onClick={() => fix(line.fix as StartupFix)}>
          {line.fix.label}
        </button>
      )}
      <button type="button" className="sc-x" aria-label={t('flow.startup.dismiss')} title={t('flow.startup.dismiss')} onClick={() => setHidden(true)}>
        ×
      </button>
    </div>
  );
}
