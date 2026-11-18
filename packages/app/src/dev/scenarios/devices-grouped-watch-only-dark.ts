import { NODE_MAC } from '../devices-fixtures';
import type { HarnessScenario } from '../types';
import base, { LAPTOP, LAPTOP_PROJECTS } from './devices-grouped-picker-dark';

// A REN-LAPTOP project picked while REN-LAPTOP lets this PC only watch: Start is replaced by the plain line and the real Ask button.
const s: HarnessScenario = {
  ...base,
  name: 'devices-grouped-watch-only-dark',
  devices: { name: 'REN-DESK', devices: [{ ...LAPTOP, level: 'watch' }], projectsOf: { [NODE_MAC]: LAPTOP_PROJECTS } },
  after: async (dom) => {
    await base.after!(dom);
    await dom.click(`[data-testid="na-group-${NODE_MAC}"] .ck-na-item`);
    await dom.waitFor('[data-testid="na-agents-off"]');
    await dom.sleep(400);
  },
};
export default s;
