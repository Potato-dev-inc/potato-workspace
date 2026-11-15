import type { HarnessScenario } from '../types';
import type { UsageRow, UsageSnapshot } from '../../lib/usage';

// The Usage popover on a PC that lends and borrows: ONE Claude row for the main account, a lend profile that is
// switched on (named by the profile, marked as the same account), and a borrowed account named by the lender's profile.
const now = Date.now();
const H = 3_600_000;
const base: UsageRow = {
  agent_id: 'claude',
  label: 'Claude',
  account_id: null,
  account_label: null,
  state: 'ok',
  reason: null,
  windows: [
    { name: '5-hour', used_percent: 76, minutes: 300, resets_at_ms: now + 2 * H, reset_since: false },
    { name: 'Weekly', used_percent: 83, minutes: 10080, resets_at_ms: now + 60 * H, reset_since: false },
  ],
  plan: 'Max',
  observed_at_ms: now - 60_000,
  limited_until_ms: null,
  page: 'https://claude.ai/settings/usage',
};
const usage: UsageSnapshot = {
  refreshed_at_ms: now,
  rows: [
    base,
    { ...base, account_id: 'lend_a', account_label: 'Work account', link: 'lend', same_as_main: true },
    { ...base, account_id: 'lend:g1', account_label: "Ren's Work account (borrowed)", link: 'borrowed', windows: [{ name: '5-hour', used_percent: 22, minutes: 300, resets_at_ms: now + 4 * H, reset_since: false }], plan: null },
  ],
};

const s: HarnessScenario = {
  name: 'lend-usage-popover',
  route: 'cockpit',
  window: { width: 1440, height: 900 },
  usage,
  after: async (dom) => {
    await dom.click('.ck-sb-chips .ck-usage-chip');
    await dom.sleep(600);
  },
};
export default s;
