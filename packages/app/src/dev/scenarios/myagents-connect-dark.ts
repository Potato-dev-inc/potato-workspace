import { MAC_MINI, MAC_PANES, NODE_MAC } from '../devices-fixtures';
import { GRANT_OUT, MY_PROFILE, lendState } from '../lend-fixtures';
import { setLanguagePref } from '../../i18n';
import type { HarnessScenario } from '../types';

// "Use my own agents" (P6.1): myagents-connect-dark.
const lentGrant = { ...GRANT_OUT, id: 'lg_mine', peer_member_id: 'me', peer_name: '', peer_device_name: 'Mac mini', peer_node: NODE_MAC, for_other_person: false, pane_ids: [`dev:${NODE_MAC}:p1`], ends_ms: Date.now() + 11 * 3600_000, requests: 12, input_tokens: 41_200, output_tokens: 7_300 };
const s: HarnessScenario = {
  name: 'myagents-connect-dark',
  route: 'cockpit',
  theme: 'dark',
  window: { width: 1280, height: 800 },
  devices: { devices: [MAC_MINI], panes: { [NODE_MAC]: MAC_PANES } },
  lend: lendState({ profiles: [MY_PROFILE], grants: [lentGrant] }),
  after: async (dom) => {
    setLanguagePref('en', false);
    await dom.waitFor('[data-testid="side-connect"]');
    await dom.click('[data-testid="side-connect"]');
    await dom.waitFor(`[data-testid="connect-lent-${NODE_MAC}"]`);
    await dom.sleep(500);
  },
};
export default s;
