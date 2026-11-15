import type { HarnessScenario } from '../types';
import { setSpeak } from '../../lib/companionSpeak';

// More than one companion: three rows, the default mark, own colours and "+ New companion" (light).
const s: HarnessScenario = {
  name: 'companions-many-light-1280',
  route: 'cockpit',
  companion: 'idle',
  moreCompanions: true,
  theme: 'light',
  window: { width: 1280, height: 900 },
  after: async (dom) => {
    await dom.sleep(800);
    setSpeak({ on: false, offered: true });
    await dom.sleep(200);
  },
};
export default s;
