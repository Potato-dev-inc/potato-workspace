// The "Used" strip in the harness: SYNTHETIC rows, times relative to when the page opens.
import type { UsageSnapshot } from '../lib/usage';

const H = 3_600_000;

export function exampleUsage(now = Date.now()): UsageSnapshot {
  return {
    refreshed_at_ms: now,
    rows: [
      {
        agent_id: 'claude',
        label: 'Claude',
        account_id: null,
        account_label: null,
        state: 'unknown',
        reason: 'Claude keeps plan usage on its servers. Type /usage in a Claude pane, or open the usage page.',
        windows: [],
        plan: null,
        observed_at_ms: null,
        limited_until_ms: null,
        page: 'https://claude.ai/settings/usage',
      },
      {
        agent_id: 'codex',
        label: 'Codex CLI',
        account_id: null,
        account_label: null,
        state: 'ok',
        reason: null,
        windows: [
          { name: '5-hour', used_percent: 87, minutes: 300, resets_at_ms: now + 9 * H + 55 * 60_000, reset_since: false },
          { name: 'Weekly', used_percent: 31, minutes: 10080, resets_at_ms: now + 4 * 24 * H, reset_since: false },
        ],
        plan: 'plus',
        observed_at_ms: now - 4 * 60_000,
        limited_until_ms: null,
        page: 'https://chatgpt.com/codex/settings/usage',
      },
      {
        agent_id: 'codex',
        label: 'Codex CLI',
        account_id: 'acc_work',
        account_label: 'Work',
        state: 'limited',
        reason: null,
        windows: [{ name: 'Monthly', used_percent: 100, minutes: 43200, resets_at_ms: now + 12 * 24 * H + H, reset_since: false }],
        plan: 'free',
        observed_at_ms: now - 30 * 60_000,
        limited_until_ms: now + 12 * 24 * H + H,
        page: 'https://chatgpt.com/codex/settings/usage',
      },
      {
        agent_id: 'cursor_agent',
        label: 'Cursor Agent CLI',
        account_id: null,
        account_label: null,
        state: 'expired',
        reason: 'The sign-in has expired. Open the agent and sign in again.',
        windows: [],
        plan: null,
        observed_at_ms: null,
        limited_until_ms: null,
        page: 'https://cursor.com/dashboard?tab=usage',
      },
    ],
  };
}
