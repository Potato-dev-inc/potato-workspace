import { teamPageLend, teamPageState } from '../team-page-fixtures';
import type { HarnessScenario } from '../types';

// wiring-team-invite-light: headless evidence for the 1.1.1 wiring.
const s: HarnessScenario = {
  name: 'wiring-team-invite-light',
  route: 'cockpit',
  theme: 'light',
  window: { width: 1100, height: 800 },
  team: teamPageState(),
  lend: teamPageLend(),
  worker: { inviteLink: true },
  after: async (dom) => {
    await dom.waitFor('[data-testid="side-connect"]');
    await dom.click('[data-testid="side-connect"]');
    await dom.click('[data-testid="connect-tab-team"]');
    await dom.waitFor('[data-testid="team-invite"]');
    await dom.click('[data-testid="team-invite"]');
    await dom.waitFor('[data-testid="invite-sheet"]');
    await dom.sleep(500);
  },
};
export default s;
