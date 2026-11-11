import { useCallback, useEffect, useRef, useState } from "react";
import type { DevicePing, TeamApi } from "../../../lib/team";

/** How often the page pings again while it is open. */
export const PING_EVERY_MS = 30_000;

export interface TeamPings {
  /** The newest result per computer, by device id. */
  byDevice: Record<string, DevicePing>;
  busy: boolean;
  /** The backend refused or failed as a whole (not one computer being away). */
  error: string | null;
  ping: () => void;
}

/**
 * Pings of the team's computers for Settings > Team > People: once when the page opens, every 30 seconds while it
 * stays open (not while the window is hidden), and on demand. Off (and silent) unless `active`: a relay team on a
 * backend that can ping.
 */
export function useTeamPings(api: TeamApi, active: boolean): TeamPings {
  const [byDevice, setBy] = useState<Record<string, DevicePing>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);
  const alive = useRef(true);

  const ping = useCallback(() => {
    if (!api.ping || running.current) return;
    running.current = true;
    setBusy(true);
    api
      .ping()
      .then((list) => {
        if (!alive.current) return;
        setError(null);
        setBy(Object.fromEntries(list.map((p) => [p.device_id, p])));
      })
      .catch((err) => alive.current && setError(err instanceof Error ? err.message : String(err)))
      .finally(() => {
        running.current = false;
        if (alive.current) setBusy(false);
      });
  }, [api]);

  useEffect(() => {
    alive.current = true;
    if (!active) return;
    ping();
    const timer = window.setInterval(() => {
      if (!document.hidden) ping();
    }, PING_EVERY_MS);
    return () => {
      alive.current = false;
      window.clearInterval(timer);
    };
  }, [active, ping]);

  return { byDevice, busy, error, ping };
}
