import { BUILD_BOX } from '../ssh-fixtures';
import type { HarnessScenario } from '../types';

// New agent > Where with an SSH machine picked: "Build box · SSH · terminal only", a Shell and the agents its check found, a folder
// on that machine, and one button. The Linux distro of this PC is in the same list.
const s: HarnessScenario = {
  name: 'devices-where-ssh',
  route: 'cockpit',
  window: { width: 1280, height: 900 },
  devices: { devices: [] },
  ssh: { hosts: [BUILD_BOX] },
  wsl: { status: { state: 'ready', distros: [{ name: 'Ubuntu-Test', default: true, version: 2, state: 'Running' }] } },
  after: async (dom) => {
    await dom.waitFor('button[aria-label="Quick start menu"]');
    await dom.click('button[aria-label="Quick start menu"]');
    await dom.waitFor('[data-testid="where-pill"]');
    await dom.click('[data-testid="where-pill"]');
    await dom.waitFor('[data-testid="where-ssh:ssh-1"]');
    await dom.sleep(300);
    await dom.click('[data-testid="where-ssh:ssh-1"]');
    await dom.waitFor('[data-testid="ssh-panel"]');
    await dom.sleep(300);
  },
};
export default s;
