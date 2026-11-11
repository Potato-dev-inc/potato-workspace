import type { HarnessScenario } from '../types';

// Settings > Agents > Helpers: "Default model for helpers", one compact dropdown per installed agent.
const s: HarnessScenario = {
  name: 'settings-helper-models',
  route: 'settings',
  settingsTab: 'agents',
  window: { width: 1440, height: 1100 },
  after: async (dom) => {
    const row = await dom.waitFor('[data-row="helper-default-models"]');
    row?.scrollIntoView({ block: 'center' });
    await dom.sleep(500);
  },
};
export default s;
