import type { HarnessScenario } from '../types';

// Settings > Shortcuts: pressing keys another shortcut already has says who has them, with "Use it anyway".
const s: HarnessScenario = {
  name: 'shortcuts-settings-conflict',
  route: 'settings',
  settingsTab: 'shortcuts',
  after: async (dom) => {
    await dom.waitFor('[data-row="shortcut-palette"]');
    await dom.click('[data-row="shortcut-palette"] button[aria-label^="Change keys"]');
    await dom.sleep(150);
    // The recording box has the focus: the key goes to it, not to the window.
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true, cancelable: true }));
    await dom.sleep(300);
  },
};
export default s;
