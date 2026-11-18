import { NODE_MAC } from '../devices-fixtures';
import type { HarnessScenario } from '../types';
import base, { LAPTOP, LAPTOP_PROJECTS } from './devices-grouped-picker-dark';

// "Add project" of REN-LAPTOP: the sheet "Open a folder on REN-LAPTOP". A click on a project opens it at once; Browse folders is the only other action.
const s: HarnessScenario = {
  ...base,
  name: 'devices-grouped-add-sheet-dark',
  devices: { name: 'REN-DESK', devices: [LAPTOP], projectsOf: { [NODE_MAC]: LAPTOP_PROJECTS } },
  after: async (dom) => {
    await base.after!(dom);
    await dom.click(`[data-testid="na-add-${NODE_MAC}"]`);
    await dom.waitFor('[data-testid="folder-sheet-title"]');
    await dom.waitFor('[data-testid="folder-sheet-browse"]');
    await dom.sleep(400);
  },
};
export default s;
