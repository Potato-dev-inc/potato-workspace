import type { HarnessScenario } from '../types';
import { typeAndAdd } from '../add-agent-fixtures';

// Add an agent: a way to ask without a screen was found; the box asks before it sends any message.
const s: HarnessScenario = {
  name: 'aa-consent',
  route: 'settings',
  settingsTab: 'add-agent',
  window: { width: 900, height: 900 },
  addAgent: { scenario: 'needs_consent', frame: 'consent' },
  after: async (dom) => {
    await typeAndAdd(dom, 'fakeheadless');
    await dom.waitFor('[data-testid="aa-consent"]');
    await dom.sleep(300);
  },
};
export default s;
