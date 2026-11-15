import { teamConfig, teamState } from '../team-fixtures';
import type { HarnessScenario } from '../types';

// Settings > Team as the owner, on a Worker deployed before invite links: the pasted invite plus "Update your Worker" with the one command.
const s: HarnessScenario = {
  name: 'team-page-invite-old-worker',
  route: 'settings',
  settingsTab: 'team',
  window: { width: 1100, height: 900 },
  team: teamState(),
  teamConfig: teamConfig(),
  worker: { inviteNote: 'update-worker' },
  after: async (dom) => {
    await dom.waitFor('.st-team');
    await dom.clickText('button', 'Make an invite');
    await dom.waitFor('[data-testid="invite-update-worker"]');
    await dom.sleep(400);
  },
};
export default s;
