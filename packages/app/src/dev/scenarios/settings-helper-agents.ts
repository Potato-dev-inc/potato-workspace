import type { HarnessScenario } from '../types';

// Settings > Agents > Helpers: "Helper agents" (Always show them) and "Keep helpers open when they finish" (on).
const s: HarnessScenario = {
  name: 'settings-helper-agents',
  route: 'settings',
  settingsTab: 'agents',
  window: { width: 1440, height: 1100 },
  after: async (dom) => {
    const row = await dom.waitFor('[data-row="keep-helpers-open"]');
    row?.scrollIntoView({ block: 'center' });
    await dom.sleep(400);
  },
};
export default s;
