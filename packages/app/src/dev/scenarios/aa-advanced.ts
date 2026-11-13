import { FOUND_ON_THIS_PC, typeAndAdd } from '../add-agent-fixtures';
import type { HarnessScenario } from '../types';

// Settings > Agents > Add an agent (evidence for the checkpoint-1 fixes).
const s: HarnessScenario = {
  name: 'aa-advanced',
  route: 'settings',
  settingsTab: 'add-agent',
  window: { width: 900, height: 900 },
  addAgent: { scenario: 'native_ok' },
  after: async (dom) => {
    await dom.waitFor('.aa-link');
    await dom.click('.aa-link');
    await dom.sleep(300);
  },
};
export default s;
