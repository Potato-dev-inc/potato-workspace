import { FOUND_ON_THIS_PC, typeAndAdd } from '../add-agent-fixtures';
import type { HarnessScenario } from '../types';

// Settings > Agents > Add an agent (evidence for the checkpoint-1 fixes).
const s: HarnessScenario = {
  name: 'aa-idle',
  route: 'settings',
  settingsTab: 'add-agent',
  window: { width: 900, height: 900 },
  addAgent: { scenario: 'native_ok', found: FOUND_ON_THIS_PC },
  after: async (dom) => {
    await dom.waitFor('input[aria-label="Agent name"]');
    await dom.sleep(400);
  },
};
export default s;
