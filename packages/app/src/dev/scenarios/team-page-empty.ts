import type { HarnessScenario } from '../types';

// The Team page with no team yet (headless evidence).
const s: HarnessScenario = {
  name: 'team-page-empty',
  route: 'cockpit',
  theme: 'dark',
  window: { width: 1100, height: 700 },
  teamConfig: { team: '', teamName: '', members: [], joins: [] },
  after: async (dom) => {
    await dom.waitFor('[data-testid="side-team"]');
    await dom.click('[data-testid="side-team"]');
    await dom.waitFor('[data-testid="team-empty"]');
    await dom.sleep(300);
  },
};
export default s;
