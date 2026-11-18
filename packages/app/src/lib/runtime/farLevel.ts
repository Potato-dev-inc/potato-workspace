// What another PC lets THIS PC do, as that PC says it (`GET /pclink/me`). The far PC is the only one that knows: the buttons here
// only hide what it would refuse, and a refused call is still refused there. The answer is read again every few seconds while the
// PC is on screen, so a switch turned on or off at the far PC (or a "yes" to "Ask to allow agents") shows up by itself.
import { useCallback, useEffect, useRef, useState } from 'react';
import { pollWithBackoff } from './pollWithBackoff';
import type { PcLevel, PcLinkClient } from './pclink';

export const FAR_LEVEL_POLL_MS = 15_000;
/** While a "can I work on this PC" question waits for an answer, the answer is also looked for this often (failures still back off). */
export const FAR_LEVEL_ASKED_POLL_MS = 5_000;

export interface FarLevel {
  /** `null`: not known (loading, offline, or the far PC does not let this PC in). */
  level: PcLevel | null;
  /** A "can I work on this PC" question is waiting at the far PC. */
  asked: boolean;
  /** Read it now (after an ask, or when the person comes back). */
  refresh: () => void;
}

export function useFarLevel(client: PcLinkClient | null, active = true): FarLevel {
  const [state, setState] = useState<{ node: string | null; level: PcLevel | null; asked: boolean }>({ node: null, level: null, asked: false });
  const live = useRef(true);
  const node = client?.node ?? null;
  const read = useCallback(() => {
    if (!client) return;
    return client.me().then(
      (me) => {
        if (live.current) setState({ node: client.node, level: me.level, asked: me.asked === true });
      },
      (error) => {
        if (live.current) setState({ node: client.node, level: null, asked: false });
        throw error;
      },
    );
  }, [client]);
  const readNow = useCallback(() => void read()?.catch(() => undefined), [read]);
  useEffect(() => {
    live.current = true;
    if (!client || !active) return undefined;
    const stop = pollWithBackoff({ node: client.node, route: 'me', normalMs: FAR_LEVEL_POLL_MS, run: () => read() as Promise<unknown> });
    return () => {
      live.current = false;
      stop();
    };
  }, [client, active, read]);
  const mine = state.node === node;
  const waiting = mine && state.asked;
  // Only while a question is pending: look for the answer sooner than the idle poll. It ends the moment the answer is in.
  useEffect(() => {
    if (!client || !active || !waiting) return undefined;
    return pollWithBackoff({ node: client.node, route: 'me-asked', normalMs: FAR_LEVEL_ASKED_POLL_MS, immediate: false, run: () => read() as Promise<unknown> });
  }, [client, active, waiting, read]);
  return { level: mine ? state.level : null, asked: mine ? state.asked : false, refresh: readNow };
}
