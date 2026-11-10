import { showSwitchFrame } from '../switch-overlay-preview';
import type { HarnessScenario } from '../types';

// The Domino switch to Individual, frozen at about half way: the real switch overlay drawn over the cockpit. The
// active pane's tile and the sidebar rows are the proxies' real starting places (read from the DOM).
const s: HarnessScenario = {
  name: 'mode-switch-domino',
  route: 'cockpit',
  theme: 'dark',
  select: 'pane-claude-1',
  after: async (dom) => {
    await dom.waitFor('[data-pane-tile]');
    await dom.waitFor('[data-pane-row]');
    await dom.sleep(500);
    await showSwitchFrame({ style: 'domino', at: 0.5 });
    await dom.sleep(300);
  },
};
export default s;
