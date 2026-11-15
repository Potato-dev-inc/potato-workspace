import { MAC_FILES, MAC_MINI, NODE_MAC } from '../devices-fixtures';
import type { HarnessScenario } from '../types';

// The preview pane of a text file in the Files tab.
const s: HarnessScenario = {
  name: 'devices-files-preview',
  route: 'settings',
  settingsTab: 'devices',
  window: { width: 900, height: 1250 },
  devices: { devices: [{ ...MAC_MINI, lets_files: true }], files: MAC_FILES },
  after: async (dom) => {
    await dom.waitFor(`[data-testid="device-${NODE_MAC}"]`);
    await dom.click(`[data-testid="device-${NODE_MAC}"]`);
    await dom.click('[data-testid="device-tab-files"]');
    await dom.waitFor('[data-testid="files-table"]');
    await dom.click('[data-testid="file-pick-README.md"]');
    await dom.click('[data-testid="file-open-README.md"]');
    await dom.waitFor('[data-testid="preview-text"]');
    await dom.sleep(300);
  },
};
export default s;
