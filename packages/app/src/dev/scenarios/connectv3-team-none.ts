import { teamConfig } from '../team-fixtures';
import type { HarnessScenario } from '../types';

// Connect v3 (three tabs), Team tab, brand new (no team).
const s: HarnessScenario = {
  name: 'connectv3-team-none',
  route: 'cockpit',
  theme: 'dark',
  tunnel: 'stable',
  teamConfig: teamConfig({ team: '' }),
  window: { width: 1280, height: 800 },
  after: async (dom) => {
    await dom.waitFor('[data-testid="side-connect"]');
    await dom.click('[data-testid="side-connect"]');
    await dom.click('[data-testid="connect-tab-team"]');
    await dom.waitFor('[data-testid="connect-panel-team"]');
    await dom.sleep(900);
    document.querySelectorAll<HTMLElement>('body *').forEach((el) => {
      if (el.children.length === 0 && /^An agent took/.test(el.textContent ?? '')) ((el.closest('[role]') ?? el) as HTMLElement).style.display = 'none';
    });
  },
};
export default s;
