import type { HarnessScenario } from '../types';
import { setSpeak } from '../../lib/companionSpeak';

// The page of a companion that is not the default, with the quick switcher open (light).
const s: HarnessScenario = {
  name: 'companions-switch-light-1280',
  route: 'cockpit',
  companion: 'idle',
  moreCompanions: true,
  theme: 'light',
  window: { width: 1280, height: 900 },
  after: async (dom) => {
    await dom.sleep(800);
    setSpeak({ on: false, offered: true });
    await dom.sleep(200);
    const rows = [...document.querySelectorAll<HTMLButtonElement>('.ck-companion-row')];
    rows[1]?.click();
    await dom.sleep(600);
    await dom.clickText('.ck-companion-switch-btn', 'Switch companion');
    await dom.sleep(300);
  },
};
export default s;
