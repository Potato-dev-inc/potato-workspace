import { useCallback, useEffect, useState } from 'react';
import { lendApi, type LendApi, type LendState } from '../../lib/lend';

/** How often the state is read again when no change event came (the relay can be slow). */
const REFRESH_MS = 15_000;
/** How often "time left" is redrawn. */
const TICK_MS = 15_000;

export interface LendHandle {
  /** Null until the first answer, when Share an agent is off, or when the backend has no such command. */
  state: LendState | null;
  /** The same state even while Lending is off: a lend that ended is still news (its Inbox row shows whatever the switch says). */
  any?: LendState | null;
  /** The Labs switch, as the backend reports it. Most lend screens draw nothing while it is false; the borrow entry and the Lend page say which switch it is instead. */
  enabled: boolean;
  /** A state answer arrived (even "off"): the switch can be shown as On or Off, not guessed. */
  known: boolean;
  now: number;
  refresh: () => void;
}

/** A bad answer (an older backend, a mock that returns nothing) is no state at all. */
function sane(value: unknown): LendState | null {
  const s = value as Partial<LendState> | null;
  if (!s || typeof s !== 'object' || !Array.isArray(s.grants) || !Array.isArray(s.profiles) || !Array.isArray(s.drivers)) return null;
  return { enabled: s.enabled === true, profiles: s.profiles, grants: s.grants, requests_in: s.requests_in ?? [], requests_out: s.requests_out ?? [], drivers: s.drivers };
}

/** Share an agent's state, kept current: on `lend://changed`, every few seconds, and the clock for "time left". */
export function useLend(api: LendApi = lendApi): LendHandle {
  const [state, setState] = useState<LendState | null>(null);
  const [known, setKnown] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const refresh = useCallback(() => {
    api
      .state()
      .then((s) => {
        const saneState = sane(s);
        setState(saneState);
        setKnown(saneState !== null);
      })
      .catch(() => {
        setState(null);
        setKnown(false);
      });
  }, [api]);
  useEffect(() => {
    refresh();
    let off: (() => void) | undefined;
    let disposed = false;
    api
      .onChanged(refresh)
      .then((u) => (disposed ? u() : (off = u)))
      .catch(() => {});
    const poll = window.setInterval(refresh, REFRESH_MS);
    // Coming back to the window: look now (a lend may have ended while it was away).
    const onVisible = () => document.visibilityState === 'visible' && refresh();
    document.addEventListener('visibilitychange', onVisible);
    const tick = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => {
      disposed = true;
      off?.();
      window.clearInterval(poll);
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(tick);
    };
  }, [api, refresh]);
  return { state: state?.enabled ? state : null, any: state, enabled: state?.enabled === true, known, now, refresh };
}
