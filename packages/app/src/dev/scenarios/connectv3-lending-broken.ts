import { GRANT_OUT, MY_PROFILE, lendState } from '../lend-fixtures';
import type { HarnessScenario } from '../types';

// Connect v3 (three tabs), Lending tab, broken: the thin reach line on top.
const s: HarnessScenario = {
  name: 'connectv3-lending-broken',
  route: 'cockpit',
  theme: 'dark',
  tunnel: 'stable-failed',
  lend: lendState({ profiles: [MY_PROFILE], grants: [GRANT_OUT] }),
  window: { width: 1280, height: 800 },
  after: async (dom) => {
    await dom.waitFor('[data-testid="side-connect"]');
    await dom.click('[data-testid="side-connect"]');
    await dom.click('[data-testid="connect-tab-lending"]');
    await dom.waitFor('[data-testid="connect-reach"]');
    await dom.sleep(900);
    document.querySelectorAll<HTMLElement>('body *').forEach((el) => {
      if (el.children.length === 0 && /^An agent took/.test(el.textContent ?? '')) ((el.closest('[role]') ?? el) as HTMLElement).style.display = 'none';
    });
  },
};
export default s;
