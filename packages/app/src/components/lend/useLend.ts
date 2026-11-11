import { useCallback, useEffect, useState } from 'react';
import { lendApi, type LendApi, type LendState } from '../../lib/lend';

/** How often the state is read again when no change event came (the relay can be slow). */
const REFRESH_MS = 20_000;
/** How often "time left" is redrawn. */
const TICK_MS = 15_000;

export interface LendHandle {
  /** Null until the first answer, when Share an agent is off, or when the backend has no such command. */
  state: LendState | null;
  /** The Labs switch, as the backend reports it. Every lend screen draws nothing while it is false. */
  enabled: boolean;
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
  const [now, setNow] = useState(() => Date.now());
  const refresh = useCallback(() => {
    api
      .state()
      .then((s) => setState(sane(s)))
      .catch(() => setState(null));
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
    const tick = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => {
      disposed = true;
      off?.();
      window.clearInterval(poll);
      window.clearInterval(tick);
    };
  }, [api, refresh]);
  return { state: state?.enabled ? state : null, enabled: state?.enabled === true, now, refresh };
}
