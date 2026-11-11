import type { HarnessScenario } from '../types';

// The keyboard shortcuts sheet (Ctrl+/): the keys you set, with "Change shortcuts" next to Close.
const s: HarnessScenario = {
  name: 'shortcuts-sheet',
  route: 'cockpit',
  after: async (dom) => {
    dom.key('/', { ctrl: true });
    await dom.waitFor('.ck-sheet--shortcuts');
    await dom.sleep(300);
  },
};
export default s;
