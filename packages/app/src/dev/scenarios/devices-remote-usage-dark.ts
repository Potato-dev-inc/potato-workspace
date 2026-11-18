import { MAC_PANES, NODE_MAC } from '../devices-fixtures';
import { phoneRenderReply } from '../phone-render-fixture';
import type { HarnessScenario } from '../types';
import { exampleUsage } from '../usage-fixtures';
import { LAPTOP } from './devices-grouped-picker-dark';

// A Claude session running on REN-LAPTOP, open here: the usage bar at the bottom shows REN-LAPTOP's own numbers with its name as a small tag,
// never this PC's (which are on the bar when a local session is open).
const NOW = Date.now();
const H = 3_600_000;
const s: HarnessScenario = {
  name: 'devices-remote-usage-dark',
  route: 'cockpit',
  theme: 'dark',
  window: { width: 1280, height: 800 },
  usage: exampleUsage(),
  devices: {
    name: 'REN-DESK',
    devices: [LAPTOP],
    panes: { [NODE_MAC]: MAC_PANES },
    chats: { p1: phoneRenderReply(NOW).items },
    usageOf: {
      [NODE_MAC]: {
        refreshed_at_ms: NOW,
        rows: [
          { agent_id: 'claude', label: 'Claude', account_id: null, account_label: null, state: 'ok', reason: null, windows: [{ name: '5-hour', used_percent: 42, minutes: 300, resets_at_ms: NOW + 2 * H, reset_since: false }, { name: 'Weekly', used_percent: 18, minutes: 10080, resets_at_ms: NOW + 3 * 24 * H, reset_since: false }], plan: 'max', observed_at_ms: NOW - 120_000, limited_until_ms: null, page: null },
          { agent_id: 'codex', label: 'Codex CLI', account_id: null, account_label: null, state: 'ok', reason: null, windows: [{ name: '5-hour', used_percent: 64, minutes: 300, resets_at_ms: NOW + 3 * H, reset_since: false }], plan: 'plus', observed_at_ms: NOW - 120_000, limited_until_ms: null, page: null },
        ],
      },
    },
  },
  after: async (dom) => {
    await dom.waitFor(`[data-pane-row="dev:${NODE_MAC}:p1"]`);
    await dom.click(`[data-pane-row="dev:${NODE_MAC}:p1"]`);
    await dom.waitFor('[data-testid="usage-far-tag"]');
    await dom.sleep(600);
  },
};
export default s;
