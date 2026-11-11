import type { HarnessScenario } from '../types';

// Settings > Shortcuts: every shortcut you can change, by group, with Change / Turn off / Reset on each row.
const s: HarnessScenario = {
  name: 'shortcuts-settings',
  route: 'settings',
  settingsTab: 'shortcuts',
  after: async (dom) => {
    await dom.waitFor('[data-row="shortcut-palette"]');
    await dom.sleep(300);
  },
};
export default s;
