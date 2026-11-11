import { GRANT_IN, GRANT_OUT, lendState, LEND_MEMBERS } from '../lend-fixtures';
import { teamState } from '../team-fixtures';
import type { HarnessScenario } from '../types';

// Settings > Team > People: "Lending Claude to Maya · 2h 14m left" with Revoke, "Borrowing Codex from Sam" with Give back.
const s: HarnessScenario = {
  name: 'lend-member-rows',
  route: 'settings',
  settingsTab: 'team',
  window: { width: 1100, height: 800 },
  team: teamState(),
  teamConfig: { members: LEND_MEMBERS, joins: [] },
  lend: lendState({ grants: [GRANT_OUT, GRANT_IN] }),
  after: async (dom) => {
    await dom.waitFor('.lend-lends');
    await dom.sleep(300);
  },
};
export default s;
