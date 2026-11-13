import type { HarnessScenario } from '../types';

// Settings > Look and feel (the Language row). Evidence for the translation work: run with `roam.mjs --lang zh-TW`.
const s: HarnessScenario = {
  name: 'i18n-look',
  route: 'settings',
  settingsTab: 'look',
  theme: 'dark',
  window: { width: 1280, height: 820 },
  after: async (dom) => {
    await dom.sleep(1200);
  },
};
export default s;
