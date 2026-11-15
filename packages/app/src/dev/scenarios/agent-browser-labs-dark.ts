import type { HarnessScenario } from '../types';

// Settings > Early features (Labs) > Agent browser (off by default). Opened on the row itself: the page scrolls to it and it glows.
const s: HarnessScenario = {
  name: 'agent-browser-labs-dark',
  route: 'settings',
  settingsTab: 'agent-browser-labs',
  theme: 'dark',
  window: { width: 1280, height: 820 },
  after: async (dom) => {
    await dom.waitFor('[data-row="agent-browser-labs"]');
    await dom.sleep(900);
  },
};
export default s;
