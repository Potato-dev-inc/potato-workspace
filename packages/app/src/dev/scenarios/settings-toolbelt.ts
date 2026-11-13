import type { HarnessScenario } from '../types';

// Settings > Bridge & MCP: the Toolbelt list sits at the top.
const s: HarnessScenario = {
  name: 'settings-toolbelt',
  route: 'settings',
  settingsTab: 'bridge',
  after: async (dom) => {
    await dom.waitFor('[aria-label="Tools for every agent"] li');
    await dom.sleep(300);
  },
};
export default s;
