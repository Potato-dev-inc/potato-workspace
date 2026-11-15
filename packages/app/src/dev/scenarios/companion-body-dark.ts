import type { HarnessScenario } from '../types';
import { setSpeak } from '../../lib/companionSpeak';

// The companion's page with its body state and journal (Labs: companion vault), dark.
const s: HarnessScenario = {
  name: 'companion-body-dark',
  route: 'cockpit',
  companion: 'idle',
  companionBody: true,
  theme: 'dark',
  window: { width: 1280, height: 900 },
  after: async (dom) => {
    await dom.sleep(800);
    setSpeak({ on: false, offered: true });
    await dom.sleep(200);
    document.querySelector<HTMLButtonElement>('.ck-companion-row')?.click();
    await dom.sleep(1000);
  },
};
export default s;
