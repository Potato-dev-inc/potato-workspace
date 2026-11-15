import { PANE_CLAUDE } from '../fixtures';
import type { HarnessScenario } from '../types';

// wiring-join-popup-dark: headless evidence for the 1.1.1 wiring.
const s: HarnessScenario = {
  name: 'wiring-join-popup-dark',
  route: 'cockpit',
  select: PANE_CLAUDE,
  theme: 'dark',
  window: { width: 1280, height: 800 },
  after: async (dom) => {
    await dom.waitFor('.ck-main');
    await dom.sleep(600);
    window.dispatchEvent(new CustomEvent('pm:join-link', { detail: 'https://pm-relay.acme.workers.dev/join/ABCDEFGH23456789' }));
    await dom.waitFor('[data-testid="join-popup"]');
    await dom.sleep(700);
  },
};
export default s;
