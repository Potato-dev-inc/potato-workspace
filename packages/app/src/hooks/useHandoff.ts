// "Handoff from here": one hook that both the sidebar (row menu) and the pane's top bar ("Hand off") use, so there is
// one starter and one "one at a time". The cockpit holds it once and passes it down.
import { useRef, useState } from 'react';
import { realHandoffDeps, runHandoff, type HandoffDeps, type HandoffStatus } from '../lib/handoff';
import type { CockpitApi } from './useCockpit';

export interface HandoffControl {
  /** Where it is: writing, opening, done or failed. Null before the first one and after Dismiss. */
  status: HandoffStatus | null;
  /** A handoff is running: no second one starts. */
  busy: boolean;
  /** Plain shells have no conversation to hand over. */
  allowed: (paneId: string) => boolean;
  start: (paneId: string) => void;
  dismiss: () => void;
}

export function useHandoff(c: CockpitApi, deps?: HandoffDeps): HandoffControl {
  const [status, setStatus] = useState<HandoffStatus | null>(null);
  const busy = status?.kind === 'writing' || status?.kind === 'opening';
  const cRef = useRef(c);
  cRef.current = c;
  const start = (paneId: string) => {
    if (busy) return;
    const real =
      deps ??
      realHandoffDeps({
        pane: (id) => {
          const pane = cRef.current.registry.panes.get(id);
          return pane && { id, agentType: pane.info.agent_type, cwd: pane.info.cwd, lane: pane.info.lane as string | undefined, status: pane.status };
        },
        newAgent: (...args) => cRef.current.newAgent(...args),
        select: (id) => cRef.current.select(id),
        titleOf: (id) => cRef.current.names.get(id),
      });
    setStatus({ kind: 'writing', text: 'Writing handoff…' });
    void runHandoff(paneId, real, setStatus);
  };
  const allowed = (id: string): boolean => {
    const type = c.registry.panes.get(id)?.info.agent_type;
    return !!type && !c.launchEntries.find((e) => e.type === type)?.shell;
  };
  return { status, busy, allowed, start, dismiss: () => setStatus(null) };
}
