import type { HarnessScenario } from '../types';

// 1.1.9 evidence: settings-logo-row.
const s: HarnessScenario = {
  name: 'settings-logo-row',
  route: 'settings',
  settingsTab: 'agents',
  window: { width: 1100, height: 1000 },
  after: async (dom) => {
    await dom.waitFor('[data-testid^="agent-row-"] .ag-open');
    await dom.click('[data-testid^="agent-row-"] .ag-open');
    await dom.waitFor('[data-testid="agent-logo-file"]');
    await dom.sleep(300);
  },
};
export default s;
