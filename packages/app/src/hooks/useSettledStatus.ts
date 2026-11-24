import { useEffect, useRef, useState } from 'react';

/** The pane status as the header shows it: "running" stays at least 1.5 s and leaves only after 1 s of calm, so a one-line turn does not flicker Working, Done, Working. */
export function useSettledStatus(status: string | undefined, holdMs = 1500, calmMs = 1000): string | undefined {
  const [shown, setShown] = useState(status);
  const since = useRef(Date.now());
  useEffect(() => {
    if (status === shown) return;
    const leaving = shown === 'running' && status !== undefined && status !== 'waiting_input' && status !== 'error';
    const wait = leaving ? Math.max(calmMs, holdMs - (Date.now() - since.current)) : 0;
    const apply = () => {
      since.current = Date.now();
      setShown(status);
    };
    if (wait <= 0) {
      apply();
      return;
    }
    const timer = setTimeout(apply, wait);
    return () => clearTimeout(timer);
  }, [status, shown, holdMs, calmMs]);
  return shown;
}
