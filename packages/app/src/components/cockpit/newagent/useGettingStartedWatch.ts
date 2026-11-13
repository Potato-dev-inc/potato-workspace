// Ticks the Getting started list from what happens anywhere in the cockpit: a second agent, a split view, a paired
// phone, a limit in Settings. (A reviewed change and an undone turn tick from their own screens, with markStep.)
// The first time it also looks at what the person already did, so an existing user sees those steps ticked.
import { useEffect } from 'react';
import { loadSettings } from '../../../lib/settings';
import { subscribeSettingsRefresh } from '../../../lib/settings-sync';
import { tauri } from '../../../lib/tauri';
import { markStep, seedSteps, type StepId } from '../../../lib/getting-started';
import { readSplitMemory } from '../split-memory';

export interface WatchDeps {
  phonePaired: () => Promise<boolean>;
  limitSet: () => Promise<boolean>;
  hadSplit: () => boolean;
}

export const realWatchDeps: WatchDeps = {
  phonePaired: async () => ((await tauri.listPairedMobileDevices().catch(() => [])) ?? []).length > 0,
  limitSet: async () => {
    const s = await loadSettings().catch(() => null);
    return (s?.budget_default_turns ?? 0) > 0 || (s?.budget_default_minutes ?? 0) > 0;
  },
  hadSplit: () => readSplitMemory() !== null,
};

export function useGettingStartedWatch(opts: { ready: boolean; agentCount: number; splitOn: boolean; deps?: WatchDeps }): void {
  const { ready, agentCount, splitOn, deps = realWatchDeps } = opts;

  // The settings-side steps: looked at once the panes are known, and again whenever settings may have changed.
  useEffect(() => {
    if (!ready) return;
    let live = true;
    const look = async (first: boolean) => {
      const [phone, limit] = await Promise.all([deps.phonePaired().catch(() => false), deps.limitSet().catch(() => false)]);
      if (!live) return;
      if (first) {
        const already: StepId[] = [];
        if (agentCount >= 2) already.push('second');
        if (deps.hadSplit()) already.push('side');
        if (phone) already.push('phone');
        if (limit) already.push('limit');
        seedSteps(already);
      }
      if (phone) markStep('phone');
      if (limit) markStep('limit');
    };
    void look(true);
    const off = subscribeSettingsRefresh(() => void look(false));
    return () => {
      live = false;
      off();
    };
    // `agentCount` only matters for the first look.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  useEffect(() => {
    if (ready && agentCount >= 2) markStep('second');
  }, [ready, agentCount]);

  useEffect(() => {
    if (splitOn) markStep('side');
  }, [splitOn]);
}
