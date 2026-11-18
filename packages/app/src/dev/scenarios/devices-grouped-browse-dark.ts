import { NODE_MAC } from '../devices-fixtures';
import type { HarnessScenario } from '../types';
import base, { LAPTOP, LAPTOP_PROJECTS } from './devices-grouped-picker-dark';

// Browse folders on REN-LAPTOP (Full): Home / code / invoice-importer, with the folder you are in and its own Open button.
const s: HarnessScenario = {
  ...base,
  name: 'devices-grouped-browse-dark',
  devices: {
    name: 'REN-DESK',
    devices: [LAPTOP],
    projectsOf: { [NODE_MAC]: LAPTOP_PROJECTS },
    browseTree: { [NODE_MAC]: { roots: [{ id: 'r-home', name: 'Home' }, { id: 'r-code', name: 'code' }], dirs: { 'r-home|': ['code', 'Documents', 'notes'], 'r-home|code': ['billing-service', 'invoice-importer', 'mobile-app'], 'r-home|code/invoice-importer': [] } } },
  },
  after: async (dom) => {
    await base.after!(dom);
    await dom.click(`[data-testid="na-add-${NODE_MAC}"]`);
    await dom.waitFor('[data-testid="folder-sheet-browse"]');
    await dom.click('[data-testid="folder-sheet-browse"]');
    await dom.waitFor('[data-testid="folder-sheet-root-r-home"]');
    await dom.click('[data-testid="folder-sheet-root-r-home"]');
    await dom.waitFor('[data-testid="folder-sheet-dir-code"]');
    await dom.click('[data-testid="folder-sheet-dir-code"]');
    await dom.waitFor('[data-testid="folder-sheet-dir-invoice-importer"]');
    await dom.click('[data-testid="folder-sheet-dir-invoice-importer"]');
    await dom.waitFor('[data-testid="folder-sheet-open"]');
    await dom.sleep(400);
  },
};
export default s;
