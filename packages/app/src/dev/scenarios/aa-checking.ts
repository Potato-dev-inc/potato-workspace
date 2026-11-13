import { FOUND_ON_THIS_PC, typeAndAdd } from '../add-agent-fixtures';
import type { HarnessScenario } from '../types';

// Settings > Agents > Add an agent (evidence for the checkpoint-1 fixes).
const s: HarnessScenario = {
  name: 'aa-checking',
  route: 'settings',
  settingsTab: 'add-agent',
  window: { width: 900, height: 900 },
  addAgent: { scenario: 'handshake_silent', frame: 3 },
  after: async (dom) => {
    await typeAndAdd(dom, 'fakemute');
  },
};
export default s;
