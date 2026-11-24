// What a plain start on another PC will run on: that PC's own sign-in, or the sign-in this PC lent it (`own_borrow_plan`).
// Read when the agent is picked and again every so often (a lend can start or end meanwhile). A far PC that does not know the row says nothing.
import { useEffect, useState } from 'react';

export interface FarPlan {
  /** The far PC's own login for the agent is signed out. */
  signedOut: boolean;
  /** The lend this PC made that a start there takes now; its display name. */
  lend: { grantId: string; name: string } | null;
}

export type FarPlanOf = (agentId: string) => Promise<FarPlan | null>;

export const FAR_PLAN_POLL_MS = 15_000;

export function useFarPlan(plan: FarPlanOf | undefined, agentId: string | null): FarPlan | null {
  const [state, setState] = useState<{ key: string; plan: FarPlan | null }>({ key: '', plan: null });
  useEffect(() => {
    if (!plan || !agentId) return undefined;
    let live = true;
    const read = () =>
      plan(agentId).then(
        (answer) => live && setState({ key: agentId, plan: answer }),
        () => live && setState({ key: agentId, plan: null }),
      );
    void read();
    const timer = window.setInterval(() => void read(), FAR_PLAN_POLL_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [plan, agentId]);
  return state.key === agentId ? state.plan : null;
}
