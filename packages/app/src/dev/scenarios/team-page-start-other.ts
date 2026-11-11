import { teamConfig, teamState } from '../team-fixtures';
import type { HarnessScenario } from '../types';

// Settings > Team > Start with "Other ways" open.
const s: HarnessScenario = {
  name: 'team-page-start-other',
  route: 'settings',
  settingsTab: 'team',
  window: { width: 1100, height: 760 },
  team: teamState(),
  teamConfig: teamConfig({ enabled: false, team: '', teamName: '', relay: '', name: '', members: [], joins: [], admin: false, transport: null, link: null }),
  after: async (dom) => {
    await dom.waitFor('.st-team');
    await dom.clickText('.tp-choice', 'Start a team');
    await dom.clickText('button', 'Other ways');
    await dom.sleep(250);
  },
};
export default s;
