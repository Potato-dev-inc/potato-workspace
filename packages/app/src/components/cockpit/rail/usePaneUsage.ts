// The helpers' usage for the Helpers card. Read again whenever `stamp` changes: the rail builds it from the
// pane's and its helpers' statuses, which change when a turn ends, so the numbers follow the turns.
import { useEffect, useState } from 'react';
import { useHost } from '../../../lib/host/context';
import { paneUsageFor, type PaneUsage } from '../../../lib/pane-usage';

export function usePaneUsage(paneId: string, enabled: boolean, stamp: string): PaneUsage | null {
  const [usage, setUsage] = useState<PaneUsage | null>(null);
  const host = useHost();
  useEffect(() => {
    if (!enabled) {
      setUsage(null);
      return;
    }
    let live = true;
    paneUsageFor(host, paneId)
      .then((next) => {
        if (live) setUsage(next);
      })
      .catch(() => {
        if (live) setUsage(null);
      });
    return () => {
      live = false;
    };
  }, [host, paneId, enabled, stamp]);
  return usage;
}
