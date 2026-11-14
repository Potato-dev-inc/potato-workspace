// The drawer foot's usage line: this month's turns, read from the PC's plans report when the drawer opens (read only, no chat text).
// Null until it is known, and on an old PC that has no such report: the line then shows just "Usage".
import { useEffect, useState } from 'react';
import type { PlansApi } from './plans-report';

export function usePlansTurns(api: PlansApi | null, active: boolean): number | null {
  const [turns, setTurns] = useState<number | null>(null);
  useEffect(() => {
    if (!api || !active) return;
    let live = true;
    api
      .report()
      .then((report) => live && setTurns(report.totals.turns))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [api, active]);
  return turns;
}
