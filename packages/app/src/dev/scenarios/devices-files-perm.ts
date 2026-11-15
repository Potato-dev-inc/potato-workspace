import { MAC_FILES, MAC_MINI, NODE_MAC } from '../devices-fixtures';
import type { HarnessScenario } from '../types';

// The device page with "Open shared folders here" on, the shared project folders and one folder the person added.
const s: HarnessScenario = {
  name: 'devices-files-perm',
  route: 'settings',
  settingsTab: 'devices',
  window: { width: 900, height: 1000 },
  devices: {
    devices: [{ ...MAC_MINI, lets_run: true, lets_files: true }],
    files: { ...MAC_FILES, folders: { shared: ['app', 'notes'], chosen: ['C:\\Users\\dev\\Pictures'] } },
  },
  after: async (dom) => {
    await dom.waitFor(`[data-testid="device-${NODE_MAC}"]`);
    await dom.click(`[data-testid="device-${NODE_MAC}"]`);
    await dom.waitFor('[data-testid="folder-chosen"]');
    await dom.sleep(300);
  },
};
export default s;
