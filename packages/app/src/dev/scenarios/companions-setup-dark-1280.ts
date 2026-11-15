import type { HarnessScenario } from '../types';
import { setSpeak } from '../../lib/companionSpeak';

// "Make another companion": colour pick and "Start from" (dark).
const s: HarnessScenario = {
  name: 'companions-setup-dark-1280',
  route: 'cockpit',
  companion: 'idle',
  moreCompanions: true,
  theme: 'dark',
  window: { width: 1280, height: 900 },
  after: async (dom) => {
    await dom.sleep(800);
    setSpeak({ on: false, offered: true });
    await dom.sleep(200);
    document.querySelector<HTMLButtonElement>('.ck-companion-new')?.click();
    await dom.sleep(600);
  },
};
export default s;
