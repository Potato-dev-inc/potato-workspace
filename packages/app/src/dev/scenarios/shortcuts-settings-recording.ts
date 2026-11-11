import type { HarnessScenario } from '../types';

// Settings > Shortcuts: "Change" on a row listens for the next keys ("Press the keys… (Esc to cancel)").
const s: HarnessScenario = {
  name: 'shortcuts-settings-recording',
  route: 'settings',
  settingsTab: 'shortcuts',
  after: async (dom) => {
    await dom.waitFor('[data-row="shortcut-palette"]');
    await dom.click('[data-row="shortcut-palette"] button[aria-label^="Change keys"]');
    await dom.sleep(300);
  },
};
export default s;
