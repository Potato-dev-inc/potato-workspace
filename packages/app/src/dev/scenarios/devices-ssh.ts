import { BUILD_BOX, CHECK_OK } from '../ssh-fixtures';
import type { HarnessScenario } from '../types';

// Settings > Devices > Add a device > Over SSH, after Check: the form and the list of what is on the machine (system, git, node,
// each agent). Behind it: the saved SSH machines.
const s: HarnessScenario = {
  name: 'devices-ssh',
  route: 'settings',
  settingsTab: 'devices',
  window: { width: 1100, height: 1100 },
  devices: { devices: [] },
  ssh: { hosts: [BUILD_BOX], check: CHECK_OK },
  after: async (dom) => {
    await dom.waitFor('[data-testid="devices-page"]');
    await dom.click('[data-testid="add-device"]');
    await dom.waitFor('[data-testid="add-device-sheet"]');
    await dom.click('[data-testid="add-tab-ssh"]');
    await dom.waitFor('[data-testid="ssh-form"]');
    // React reads the value through the native setter and an input event.
    const target = document.querySelector<HTMLInputElement>('[data-testid="ssh-target"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(target, 'dev@build.local');
    target.dispatchEvent(new Event('input', { bubbles: true }));
    await dom.sleep(100);
    await dom.click('[data-testid="ssh-check"]');
    await dom.waitFor('[data-testid="ssh-check-list"]');
    await dom.sleep(300);
  },
};
export default s;
