// The agents that have their own remote rule on the PC, read when the phone connects, every few seconds, so that an answer to
// "Ask the PC for control" shows up, and when the app comes back to the front. An old PC without the route means no agent has a rule.
import { useCallback, useEffect, useState } from 'react';
import type { BridgeClient, PaneRuleView } from '../lib/bridge-types';

/** How often the rules are read again. They change only when the person flips a switch on the PC. */
export const RULES_POLL_MS = 5000;

const NONE: Record<string, PaneRuleView> = {};

export function usePaneRules(bridge: BridgeClient | null, ready: boolean): { rules: Record<string, PaneRuleView>; refresh: () => void } {
  const [rules, setRules] = useState<Record<string, PaneRuleView>>(NONE);

  const refresh = useCallback(() => {
    if (!bridge?.paneRules) return;
    bridge
      .paneRules()
      .then((next) => setRules((cur) => (JSON.stringify(cur) === JSON.stringify(next) ? cur : next)))
      // An old PC (404) or a dropped link: keep what is shown.
      .catch(() => undefined);
  }, [bridge]);

  useEffect(() => {
    if (!ready) return;
    refresh();
    const timer = window.setInterval(refresh, RULES_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [ready, refresh]);

  return { rules, refresh };
}
