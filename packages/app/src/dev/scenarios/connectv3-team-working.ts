import { teamConfig, teamState } from '../team-fixtures';
import type { HarnessScenario } from '../types';

// Connect v3 (three tabs), Team tab, working (today's page).
const s: HarnessScenario = {
  name: 'connectv3-team-working',
  route: 'cockpit',
  theme: 'dark',
  tunnel: 'stable',
  team: teamState(),
  teamConfig: teamConfig({}),
  window: { width: 1280, height: 800 },
  after: async (dom) => {
    await dom.waitFor('[data-testid="side-connect"]');
    await dom.click('[data-testid="side-connect"]');
    await dom.click('[data-testid="connect-tab-team"]');
    await dom.waitFor('[data-testid="team-page"]');
    await dom.sleep(900);
    document.querySelectorAll<HTMLElement>('body *').forEach((el) => {
      if (el.children.length === 0 && /^An agent took/.test(el.textContent ?? '')) ((el.closest('[role]') ?? el) as HTMLElement).style.display = 'none';
    });
  },
};
export default s;
