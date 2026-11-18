import { teamConfig, teamState } from '../team-fixtures';
import type { HarnessScenario } from '../types';

// Connect v3 (three tabs), Team tab, broken: the thin line "This PC can't be reached right now. Fix it".
const s: HarnessScenario = {
  name: 'connectv3-team-broken',
  route: 'cockpit',
  theme: 'dark',
  tunnel: 'stable-failed',
  team: teamState(),
  teamConfig: teamConfig({}),
  window: { width: 1280, height: 800 },
  after: async (dom) => {
    await dom.waitFor('[data-testid="side-connect"]');
    await dom.click('[data-testid="side-connect"]');
    await dom.click('[data-testid="connect-tab-team"]');
    await dom.waitFor('[data-testid="connect-reach"]');
    await dom.sleep(900);
    document.querySelectorAll<HTMLElement>('body *').forEach((el) => {
      if (el.children.length === 0 && /^An agent took/.test(el.textContent ?? '')) ((el.closest('[role]') ?? el) as HTMLElement).style.display = 'none';
    });
  },
};
export default s;
