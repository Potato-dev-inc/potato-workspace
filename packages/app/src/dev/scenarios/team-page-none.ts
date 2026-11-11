import { teamConfig, teamState } from '../team-fixtures';
import type { HarnessScenario } from '../types';

// Settings > Team with no team yet: two big choices and nothing else.
const s: HarnessScenario = {
  name: 'team-page-none',
  route: 'settings',
  settingsTab: 'team',
  window: { width: 1100, height: 760 },
  team: teamState(),
  teamConfig: teamConfig({ enabled: false, team: '', teamName: '', relay: '', name: '', members: [], joins: [], admin: false, transport: null, link: null }),
  after: async (dom) => {
    await dom.waitFor('.st-team');
    await dom.sleep(250);
  },
};
export default s;
