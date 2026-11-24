// "Use my own agents": while a far chat on one of my lends is open, the lend rolls on (12 hours from now). Seen from THIS PC: the far PC never
// asks. Once nothing on the lend is open any more, it is left to run out (and Connect's Stop ends it sooner).
import { useEffect, useRef } from 'react';
import { tauriOwnAgentsApi, type OwnAgentsApi } from '../../lib/host/ownAgents';
import { isActiveOut } from '../../lib/lend';
import type { LendHandle } from './useLend';

/** How often the open far chats are looked at. */
export const KEEP_EVERY_MS = 5 * 60_000;
/** A lend is rolled on once it has less than this left (so the first look after an hour does it, then every 11 hours). */
const ROLL_WHEN_LEFT_MS = 11 * 3600_000;

export function useKeepLentFar(lend: LendHandle, openPaneKeys: readonly string[], api: OwnAgentsApi = tauriOwnAgentsApi, every: number = KEEP_EVERY_MS): void {
  const latest = useRef({ lend, openPaneKeys });
  latest.current = { lend, openPaneKeys };
  useEffect(() => {
    const look = () => {
      const { lend: l, openPaneKeys: open } = latest.current;
      const now = Date.now();
      for (const g of l.state?.grants ?? []) {
        if (!isActiveOut(g, now) || !g.peer_node || g.ends_ms - now > ROLL_WHEN_LEFT_MS) continue;
        if (g.pane_ids.some((p) => open.includes(p))) void api.renew(g.id).then(() => l.refresh()).catch(() => undefined);
      }
    };
    look();
    const id = window.setInterval(look, every);
    return () => window.clearInterval(id);
  }, [api, every]);
}
