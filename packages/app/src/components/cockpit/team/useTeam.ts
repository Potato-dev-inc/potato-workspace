import { useCallback, useEffect, useState } from 'react';
import { teamApi, type TeamApi, type TeamState } from '../../../lib/team';

/** How often local facts (branch, clean tree) are re-read while the cockpit is open. */
const REFRESH_MS = 15_000;

export type TeamHandle = { state: TeamState | null; refresh: () => void };

/** The Team state, refreshed when the backend says it changed and every few seconds. `enabled` false: reads nothing (a parent shares its own). */
export function useTeam(api: TeamApi = teamApi, enabled = true): TeamHandle {
  const [state, setState] = useState<TeamState | null>(null);
  const refresh = useCallback(() => {
    api
      .state()
      .then(setState)
      .catch(() => setState(null));
  }, [api]);
  useEffect(() => {
    if (!enabled) return;
    refresh();
    let off: (() => void) | undefined;
    let disposed = false;
    api
      .onChanged(refresh)
      .then((u) => (disposed ? u() : (off = u)))
      .catch(() => {});
    const timer = window.setInterval(refresh, REFRESH_MS);
    return () => {
      disposed = true;
      off?.();
      window.clearInterval(timer);
    };
  }, [api, refresh, enabled]);
  return { state, refresh };
}
