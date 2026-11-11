import { teamConfig, teamState } from '../team-fixtures';
import type { HarnessScenario } from '../types';

// Settings > Team when the relay cannot be reached: the status says what is wrong and offers Try again.
const s: HarnessScenario = {
  name: 'team-page-offline',
  route: 'settings',
  settingsTab: 'team',
  window: { width: 1100, height: 760 },
  team: teamState(),
  teamConfig: { link: 'offline', joins: [] },
  after: async (dom) => {
    await dom.waitFor('.st-team');
    await dom.sleep(250);
  },
};
export default s;
