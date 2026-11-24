import { MAC_MINI, MAC_PANES, NODE_MAC } from '../devices-fixtures';
import { GRANT_OUT, MY_PROFILE, lendState } from '../lend-fixtures';
import { setLanguagePref } from '../../i18n';
import type { HarnessScenario } from '../types';

// "Use my own agents" (P6.1): myagents-chat-zh.
const lentGrant = { ...GRANT_OUT, id: 'lg_mine', peer_member_id: 'me', peer_name: '', peer_device_name: 'Mac mini', peer_node: NODE_MAC, for_other_person: false, pane_ids: [`dev:${NODE_MAC}:p1`], ends_ms: Date.now() + 11 * 3600_000, requests: 12, input_tokens: 41_200, output_tokens: 7_300 };
const s: HarnessScenario = {
  name: 'myagents-chat-zh',
  route: 'cockpit',
  theme: 'light',
  window: { width: 1280, height: 800 },
  devices: { devices: [MAC_MINI], panes: { [NODE_MAC]: MAC_PANES } },
  lend: lendState({ profiles: [MY_PROFILE], grants: [lentGrant] }),
  after: async (dom) => {
    setLanguagePref('zh-TW', false);
    await dom.waitFor(`[data-pane-row="dev:${NODE_MAC}:p1"]`);
    await dom.click(`[data-pane-row="dev:${NODE_MAC}:p1"]`);
    await dom.waitFor('[data-testid="lent-chip"]');
    await dom.sleep(600);
  },
};
export default s;
