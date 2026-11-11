// Builds a first-run welcome harness scenario: the empty cockpit with the welcome over it, at a step.
import type { StepId } from '../components/firstrun/model';
import type { FirstRunScenario } from './first-run-fixtures';
import type { PaneInfo } from '../lib/tauri-types';
import type { HarnessDom, HarnessScenario } from './types';

export function firstRunScenario(opts: {
  name: string;
  window: { width: number; height: number };
  firstRun: FirstRunScenario & { step: StepId };
  theme?: 'dark' | 'light';
  /** Panes the registry lists (the demo's agent and its helper). Default: none. */
  panes?: PaneInfo[];
  after?: (dom: HarnessDom) => void | Promise<void>;
}): HarnessScenario {
  return {
    name: opts.name,
    route: 'cockpit',
    window: opts.window,
    theme: opts.theme,
    panes: opts.panes ?? [],
    firstRun: opts.firstRun,
    after: async (dom) => {
      await dom.waitFor('[data-testid="first-run"]');
      await dom.sleep(300);
      await opts.after?.(dom);
    },
  };
}
