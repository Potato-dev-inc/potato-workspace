import { GRANT_IN, GRANT_OUT, KEY_PROFILE, MY_PROFILE, TEAM_PROFILE, lendState } from '../lend-fixtures';
import type { HarnessScenario } from '../types';

// Connect v3 (three tabs), Lending tab, working: switch on, Ask to borrow, rules, what is lent and borrowed.
const s: HarnessScenario = {
  name: 'connectv3-lending-working',
  route: 'cockpit',
  theme: 'dark',
  tunnel: 'stable',
  accounts: [{ id: 'acct-lend', agent_id: 'claude', label: 'Lend login', home: 'C:/lend/claude', lend_only: true }],
  lend: lendState({ profiles: [MY_PROFILE, TEAM_PROFILE, KEY_PROFILE], grants: [GRANT_OUT, GRANT_IN] }),
  window: { width: 1280, height: 800 },
  after: async (dom) => {
    await dom.waitFor('[data-testid="side-connect"]');
    await dom.click('[data-testid="side-connect"]');
    await dom.click('[data-testid="connect-tab-lending"]');
    await dom.waitFor('[data-testid="connect-main-lending"]');
    await dom.sleep(900);
    document.querySelectorAll<HTMLElement>('body *').forEach((el) => {
      if (el.children.length === 0 && /^An agent took/.test(el.textContent ?? '')) ((el.closest('[role]') ?? el) as HTMLElement).style.display = 'none';
    });
  },
};
export default s;
