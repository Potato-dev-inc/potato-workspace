import type { HarnessScenario } from '../types';
import { exampleUsage } from '../usage-fixtures';

// The Usage popover over the app (not clipped by the sidebar): every sign-in, tightest first, bars and resets.
const s: HarnessScenario = {
  name: 'cockpit-usage-popover',
  route: 'cockpit',
  window: { width: 1440, height: 900 },
  usage: exampleUsage(),
  after: async (dom) => {
    await dom.click('.ck-sb-chips .ck-usage-chip');
    await dom.sleep(600);
  },
};
export default s;
