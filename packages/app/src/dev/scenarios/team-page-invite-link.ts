import { teamConfig, teamState } from '../team-fixtures';
import type { HarnessScenario } from '../types';

// Settings > Team as the owner: "Make an invite" gives one link that works once; the older link and code are folded.
const s: HarnessScenario = {
  name: 'team-page-invite-link',
  route: 'settings',
  settingsTab: 'team',
  window: { width: 1100, height: 900 },
  team: teamState(),
  teamConfig: teamConfig(),
  worker: { inviteLink: true },
  after: async (dom) => {
    await dom.waitFor('.st-team');
    await dom.clickText('button', 'Make an invite');
    await dom.waitFor('[data-testid="invite-join-url"]');
    await dom.sleep(400);
  },
};
export default s;
