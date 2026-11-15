import type { HarnessScenario } from '../types';
import { mountSentFromDesktop } from '../sent-from-desktop-shot';

// "from OPPO Reno13" under messages and "OPPO Reno13 is typing…" with Take back (desktop, dark).
const s: HarnessScenario = {
  name: 'sent-from-desktop-dark',
  route: 'cockpit',
  theme: 'dark',
  window: { width: 900, height: 620 },
  after: async (dom) => {
    await dom.sleep(300);
    mountSentFromDesktop();
    await dom.waitFor('[data-testid="acp-drive"]');
    await dom.sleep(600);
  },
};
export default s;
