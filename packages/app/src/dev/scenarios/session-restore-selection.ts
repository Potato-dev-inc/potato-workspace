import type { HarnessScenario } from '../types';
import { SESSION_MEMORY_KEY } from '../../components/cockpit/session-memory';
import { PANE_CLAUDE } from '../fixtures';

// The last run ended on this pane's Changes tab: the cockpit opens on it again.
const s: HarnessScenario = {
  name: 'session-restore-selection',
  route: 'cockpit',
  storage: { [SESSION_MEMORY_KEY]: JSON.stringify({ selected: { id: PANE_CLAUDE, tab: 'changes' }, terminals: [] }) },
  after: async (dom) => {
    await dom.sleep(800);
  },
};
export default s;
