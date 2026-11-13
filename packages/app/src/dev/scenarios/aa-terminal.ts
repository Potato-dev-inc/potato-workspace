import { FOUND_ON_THIS_PC, typeAndAdd } from '../add-agent-fixtures';
import type { HarnessScenario } from '../types';

// Settings > Agents > Add an agent (evidence for the checkpoint-1 fixes).
const s: HarnessScenario = {
  name: 'aa-terminal',
  route: 'settings',
  settingsTab: 'add-agent',
  window: { width: 900, height: 900 },
  addAgent: { scenario: 'terminal_only' },
  after: async (dom) => {
    await typeAndAdd(dom, 'faketerm');
  },
};
export default s;
