// ONE source for "Check my setup": the Overview cards and the Setup list both read the rows from here, so they can
// never disagree. The provider runs the checks once (and again on `refresh`); a page mounted without a provider
// (a search hit, a test) gets its own copy through the same hook.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CheckRow } from '../../lib/setup-checks';
import { errorSentence } from '../../lib/sayError';
import type { SetupCheckActions } from './SetupCheckPage';

export type SetupChecksState = { state: 'loading' } | { state: 'failed'; why: string } | { state: 'ready'; rows: CheckRow[] };

export interface SetupChecks {
  result: SetupChecksState;
  /** Runs every check again. The rows stay on screen until the new answer arrives. */
  refresh: () => void;
  /** What the fix buttons do; absent: the page's own defaults. */
  actions?: SetupCheckActions;
}

const SetupChecksContext = createContext<SetupChecks | null>(null);

/** Runs `run` on mount and on every `refresh`. A rejection becomes `failed`; nothing here throws. */
export function useRunSetupChecks(run: () => Promise<CheckRow[]>, enabled = true): SetupChecks {
  const [result, setResult] = useState<SetupChecksState>({ state: 'loading' });
  const [tick, setTick] = useState(0);
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    if (tick > 0) setResult({ state: 'loading' });
    runRef
      .current()
      .then((rows) => alive && setResult({ state: 'ready', rows }))
      .catch((error) => alive && setResult({ state: 'failed', why: errorSentence(error) }));
    return () => {
      alive = false;
    };
  }, [tick, enabled]);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return useMemo(() => ({ result, refresh }), [result, refresh]);
}

/** `enabled` false: nothing runs and nothing is provided (only the Overview page needs the checks). */
export function SetupChecksProvider({ run, enabled = true, actions, children }: { run: () => Promise<CheckRow[]>; enabled?: boolean; actions?: SetupCheckActions; children: ReactNode }) {
  const base = useRunSetupChecks(run, enabled);
  const value = useMemo(() => ({ ...base, actions }), [base, actions]);
  if (!enabled) return <>{children}</>;
  return <SetupChecksContext.Provider value={value}>{children}</SetupChecksContext.Provider>;
}

/** The shared source when a provider is above, else null. */
export function useSharedSetupChecks(): SetupChecks | null {
  return useContext(SetupChecksContext);
}
