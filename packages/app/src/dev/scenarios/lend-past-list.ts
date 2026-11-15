import { GRANT_IN, KEY_PROFILE, MY_PROFILE, lendState } from '../lend-fixtures';
import type { HarnessScenario } from '../types';

// Settings > Lend: the profile's "Show usage in the usage bar" tick (off), and past borrows folded away with a Clear.
const now = Date.now();
const past = (n: number, why: 'revoked' | 'returned' | 'expired') => ({
  ...GRANT_IN,
  id: `past-${n}`,
  state: 'ended' as const,
  end_reason: why,
  peer_name: ['Sam', 'Maya', 'Leo'][n % 3],
  profile_name: "Ren's Work account",
  ended_ms: now - n * 3_600_000,
});
const s: HarnessScenario = {
  name: 'lend-past-list',
  route: 'settings',
  settingsTab: 'lend',
  window: { width: 1100, height: 1100 },
  accounts: [{ id: 'acct-lend', agent_id: 'claude', label: 'Lend Claude 3', home: 'C:\lend\claude', lend_only: true }],
  lend: lendState({ profiles: [MY_PROFILE, KEY_PROFILE], grants: [GRANT_IN, past(1, 'returned'), past(2, 'revoked'), past(3, 'expired')] }),
  after: async (dom) => {
    await dom.waitFor('.lend-page');
    await dom.click('.lend-past > summary');
    await dom.sleep(400);
  },
};
export default s;
