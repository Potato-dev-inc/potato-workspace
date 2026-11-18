// The phone's bridge address when the page comes from the person's permanent address (a Worker that only POINTS at the PC).
// The saved address stays `<page origin>/bridge` (it is what the pairing is filed under); the address calls really go to is
// the tunnel the Worker names, asked once and kept in memory. The Worker itself never carries bridge calls, so while it cannot
// name the PC the address stays `null` (the page shows its plain "reconnecting" line) and the Worker is asked again, slowly,
// until it answers. When the link goes down later the Worker is asked again too (a restart gives the PC a new quick address).
import { useCallback, useEffect, useRef, useState } from 'react';
import { pollWithBackoff } from '../lib/runtime/pollWithBackoff';
import { mayBePointedAt, repoint, resolveTunnel, type Fetcher } from '../pwa/where';

export interface DirectBridge {
  /** Where calls go. `null` while the Worker has not named the PC yet (never the Worker's own `/bridge`) or when nothing is saved. */
  url: string | null;
  /** Ask again while the PC is not answering; `false` stops. Cheap to call on every render. */
  setStale: (stale: boolean) => void;
}

/** How often a PC that is not answering is looked for again (it backs off to a minute while the Worker itself fails). */
export const REASK_MS = 15_000;

export function useDirectBridge(saved: string | null, place: Pick<Location, 'origin' | 'protocol' | 'hostname'> = window.location, fetcher?: Fetcher): DirectBridge {
  const pointed = !!saved && mayBePointedAt(place) && saved.startsWith(place.origin);
  const [direct, setDirect] = useState<{ saved: string; url: string } | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  /** The first ask failed: the poll that was started for it ends as soon as the Worker names the PC. */
  const firstRef = useRef(false);
  const savedRef = useRef(saved);
  savedRef.current = saved;

  const startPoll = useCallback(() => {
    if (stopRef.current || !pointed) return;
    stopRef.current = pollWithBackoff({
      route: 'where',
      normalMs: REASK_MS,
      maxMs: 60_000,
      immediate: false,
      run: async () => {
        // \`fresh\` also updates the shared memory, so pairing and \`networkBase\` never use a stale tunnel.
        const tunnel = await resolveTunnel(place.origin, { fresh: true, fetcher });
        const current = savedRef.current;
        if (current) {
          // No tunnel and no error: this origin has no `where` route after all (the page is the PC's own): use it as it is.
          const next = tunnel ? repoint(current, place.origin, tunnel) : current;
          setDirect((was) => (was && was.saved === current && was.url === next ? was : { saved: current, url: next }));
        }
        if (firstRef.current) {
          firstRef.current = false;
          stopRef.current = null;
          return 'stop';
        }
        return undefined;
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pointed, place.origin]);
  const startRef = useRef(startPoll);
  startRef.current = startPoll;

  useEffect(() => {
    if (!saved || !pointed) return;
    let live = true;
    void resolveTunnel(place.origin, { fetcher })
      .then((tunnel) => live && setDirect({ saved, url: tunnel ? repoint(saved, place.origin, tunnel) : saved }))
      .catch(() => {
        // The Worker cannot name the PC yet: no address (never the Worker's own /bridge), and ask again with a wait.
        if (!live) return;
        firstRef.current = true;
        startRef.current();
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved, pointed, place.origin]);

  const setStale = useCallback(
    (stale: boolean) => {
      if (!stale) {
        // A poll that is still looking for the very first answer is not the link's to stop.
        if (firstRef.current) return;
        stopRef.current?.();
        stopRef.current = null;
        return;
      }
      startRef.current();
    },
    [],
  );
  useEffect(() => () => stopRef.current?.(), []);

  if (!saved) return { url: null, setStale };
  if (!pointed) return { url: saved, setStale };
  return { url: direct && direct.saved === saved ? direct.url : null, setStale };
}
