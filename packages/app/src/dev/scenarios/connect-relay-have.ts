import { teamConfig, teamState } from '../team-fixtures';
import type { HarnessScenario } from '../types';

// Connect > Team > Start a team, with have relay on this PC: the one relay row in the header and the recommended card.
const s: HarnessScenario = {
  name: 'connect-relay-have',
  route: 'cockpit',
  window: { width: 1280, height: 900 },
  tunnel: 'stable',
  team: teamState(),
  teamConfig: teamConfig({ enabled: false, team: '', teamName: '', relay: '', name: '', members: [], joins: [], admin: false, transport: null, link: null }),
  after: async (dom) => {
    await dom.waitFor('[data-testid="side-connect"]');
    await dom.click('[data-testid="side-connect"]');
    await dom.click('[data-testid="connect-tab-team"]');
    await dom.sleep(400);
    await dom.clickText('button', 'Start a team');
    await dom.waitFor('.tp-form');
    await dom.sleep(600);
  },
};
export default s;
