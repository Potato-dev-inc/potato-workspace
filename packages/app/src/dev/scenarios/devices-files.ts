import { MAC_FILES, MAC_MINI, NODE_MAC } from '../devices-fixtures';
import type { HarnessScenario } from '../types';

// The Files tab of a device: the table of its shared folder, one transfer running, one done.
const now = Math.floor(Date.now() / 1000);
const s: HarnessScenario = {
  name: 'devices-files',
  route: 'settings',
  settingsTab: 'devices',
  window: { width: 900, height: 1250 },
  devices: {
    devices: [{ ...MAC_MINI, lets_files: true }],
    files: MAC_FILES,
    transfers: [
      { id: 2, node: NODE_MAC, dir: 'down', name: 'build.dmg', bytes: 17_000_000, total: 48_000_000, state: 'running', error: '', saved_as: 'build.dmg' },
      { id: 1, node: NODE_MAC, dir: 'up', name: 'notes.txt', bytes: 4_000, total: 4_000, state: 'done', error: '', saved_as: '' },
    ],
    activity: [{ at: now - 60, node: NODE_MAC, name: 'Mac mini', dir: 'out', kind: 'copied' }],
  },
  after: async (dom) => {
    await dom.waitFor(`[data-testid="device-${NODE_MAC}"]`);
    await dom.click(`[data-testid="device-${NODE_MAC}"]`);
    await dom.click('[data-testid="device-tab-files"]');
    await dom.waitFor('[data-testid="files-table"]');
    await dom.sleep(300);
  },
};
export default s;
