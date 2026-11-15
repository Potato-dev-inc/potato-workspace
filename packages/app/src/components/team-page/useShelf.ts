import { useCallback, useEffect, useRef, useState } from 'react';
import type { ShelfApi, ShelfState } from '../../lib/shelf';
import type { TeamApi } from '../../lib/team';

export interface ShelfHandle {
  /** null until loaded, and when the backend could not answer (an older build, or no team). */
  state: ShelfState | null;
  /** The first load finished (with or without an answer). */
  loaded: boolean;
  reload: () => void;
}

/** Loads the shelf on mount and again when the team changes or after an action. A failed load is quiet: `state` stays null. */
export function useShelf(client: ShelfApi, team?: Pick<TeamApi, 'onChanged'>): ShelfHandle {
  const [state, setState] = useState<ShelfState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const alive = useRef(true);

  const reload = useCallback(() => {
    client
      .state()
      .then((s) => alive.current && setState(s))
      .catch(() => alive.current && setState(null))
      .finally(() => alive.current && setLoaded(true));
  }, [client]);

  useEffect(() => {
    alive.current = true;
    reload();
    let off: (() => void) | undefined;
    let disposed = false;
    team
      ?.onChanged(reload)
      .then((u) => (disposed ? u() : (off = u)))
      .catch(() => {});
    return () => {
      alive.current = false;
      disposed = true;
      off?.();
    };
  }, [reload, team]);

  return { state, loaded, reload };
}
