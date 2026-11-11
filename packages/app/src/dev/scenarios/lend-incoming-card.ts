import { lendState, REQUEST_MAYA, REQUEST_OUT } from '../lend-fixtures';
import { teamState } from '../team-fixtures';
import type { HarnessScenario } from '../types';

// Inbox > Team: "Maya's laptop wants Claude for 8 hours", the reason quoted, the "Use at your own risk" box,
// Change time and Say no. My own pending ask shows under the Request usage button.
const s: HarnessScenario = {
  name: 'lend-incoming-card',
  route: 'cockpit',
  window: { width: 1280, height: 1000 },
  team: teamState({ cards: [] }),
  lend: lendState({ requests_in: [REQUEST_MAYA], requests_out: [REQUEST_OUT] }),
  after: async (dom) => {
    await dom.waitFor('[data-lend-request]');
    await dom.sleep(300);
  },
};
export default s;
