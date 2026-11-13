import type { HarnessScenario } from '../types';

// Settings > Agents > Claude: an agent page with mixed chips (some yes, one no, the rest not seen yet).
const s: HarnessScenario = {
  name: 'agent-page-mixed',
  route: 'settings',
  settingsTab: 'agents',
  window: { width: 1280, height: 900 },
  after: async (dom) => {
    await dom.waitFor('[data-testid="agent-row-claude"]');
    await dom.sleep(400);
    await dom.click('[data-testid="agent-row-claude"] .ag-open');
    await dom.sleep(900);
  },
};
export default s;
