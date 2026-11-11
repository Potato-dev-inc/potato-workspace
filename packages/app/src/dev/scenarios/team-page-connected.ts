import { teamConfig, teamState } from '../team-fixtures';
import type { HarnessScenario } from '../types';

// Settings > Team on a team: connected, the invite (link, code, QR), and Priya waiting with Let in / Decline.
const s: HarnessScenario = {
  name: 'team-page-connected',
  route: 'settings',
  settingsTab: 'team',
  window: { width: 1100, height: 760 },
  team: teamState(),
  teamConfig: {},
  after: async (dom) => {
    await dom.waitFor('.st-team');
    await dom.clickText('button', 'Make an invite');
    await dom.waitFor('.st-invite-code');
    await dom.sleep(250);
  },
};
export default s;
