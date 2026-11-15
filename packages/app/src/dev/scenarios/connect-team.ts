import { teamState } from '../team-fixtures';
import type { HarnessScenario } from '../types';

// Connect > Team: the team line, then the Team page (people first).
const s: HarnessScenario = {
  name: 'connect-team',
  route: 'cockpit',
  window: { width: 1280, height: 900 },
  team: teamState(),
  teamConfig: {},
  after: async (dom) => {
    await dom.waitFor('[data-testid="side-connect"]');
    await dom.click('[data-testid="side-connect"]');
    await dom.click('[data-testid="connect-tab-team"]');
    await dom.waitFor('[data-testid="team-page"]');
    await dom.sleep(500);
  },
};
export default s;
