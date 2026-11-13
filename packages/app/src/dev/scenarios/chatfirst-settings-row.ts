import type { HarnessScenario } from '../types';

// Settings > Agents > Chat > Show terminals (off by default). Opened on the row itself: the page scrolls to it and it glows.
const s: HarnessScenario = {
  name: 'chatfirst-settings-row',
  route: 'settings',
  settingsTab: 'show-terminals',
  window: { width: 1440, height: 900 },
  chatFirst: true,
  after: async (dom) => {
    await dom.waitFor('[data-row="show-terminals"]');
    await dom.sleep(900);
  },
};
export default s;
