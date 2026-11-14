import { lendState, REQUEST_MAYA, REQUEST_OUT, TEAM_PROFILE } from '../lend-fixtures';
import { teamState } from '../team-fixtures';
import type { HarnessScenario } from '../types';

// Inbox > Team: "Maya's laptop wants <profile> (Claude) for 8 hours" (she picked the profile, so there is no picker), the reason quoted, the "Use at your own risk" box,
// Change time and Say no. My own pending ask shows under the Request usage button.
const s: HarnessScenario = {
  name: 'lend-incoming-card',
  route: 'cockpit',
  window: { width: 1280, height: 1000 },
  team: teamState({ cards: [] }),
  lend: lendState({ requests_in: [{ ...REQUEST_MAYA, profile_id: TEAM_PROFILE.id, profile_name: TEAM_PROFILE.name }], requests_out: [REQUEST_OUT] }),
  after: async (dom) => {
    await dom.waitFor('[data-lend-request]');
    await dom.sleep(300);
  },
};
export default s;
