import type { HarnessScenario } from '../types';

// Agent board (Ctrl+0), dark theme, 900 px wide: the three columns over the example panes.
const s: HarnessScenario = {
  name: 'agent-board-dark-900',
  route: 'cockpit',
  theme: 'dark',
  window: { width: 900, height: 820 },
  after: async (dom) => {
    dom.key('0', { ctrl: true });
    await dom.waitFor('.ck-board-cols');
    await dom.sleep(600);
  },
};
export default s;
