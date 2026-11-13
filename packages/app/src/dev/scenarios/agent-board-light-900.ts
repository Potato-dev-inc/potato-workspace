import type { HarnessScenario } from '../types';

// Agent board (Ctrl+0), light theme, 900 px wide: the three columns over the example panes.
const s: HarnessScenario = {
  name: 'agent-board-light-900',
  route: 'cockpit',
  theme: 'light',
  window: { width: 900, height: 820 },
  after: async (dom) => {
    dom.key('0', { ctrl: true });
    await dom.waitFor('.ck-board-cols');
    await dom.sleep(600);
  },
};
export default s;
