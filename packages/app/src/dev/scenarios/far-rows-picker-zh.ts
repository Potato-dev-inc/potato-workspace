import { MAC_MINI, NODE_MAC, WORK_LAPTOP } from '../devices-fixtures';
import { setLanguagePref } from '../../i18n';
import type { HarnessScenario } from '../types';

// The Run in picker: This PC and another PC are the same big entry; a Linux place of this PC is the small one under This PC (zh).
const LINUX_PC = { ...MAC_MINI, name: 'Linux PC' };
const s: HarnessScenario = {
  name: 'far-rows-picker-zh',
  route: 'cockpit',
  theme: 'dark',
  window: { width: 1280, height: 800 },
  devices: { devices: [LINUX_PC, WORK_LAPTOP], panes: { [NODE_MAC]: [] } },
  after: async (dom) => {
    setLanguagePref('zh-TW', false);
    await dom.sleep(700);
    await dom.click('button.ck-side-new--primary');
    await dom.waitFor('[data-testid="na-ask"]');
    await dom.waitFor('.ck-na-row [data-testid="where-pill"]');
    await dom.click('[data-testid="where-pill"]');
    await dom.waitFor('.dev-where-menu');
    await dom.sleep(400);
  },
};
export default s;
