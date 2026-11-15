import type { HarnessScenario } from '../types';
import { setSpeak } from '../../lib/companionSpeak';

// More than one companion: three rows, the default mark, own colours and "+ New companion" (dark).
const s: HarnessScenario = {
  name: 'companions-many-dark-1280',
  route: 'cockpit',
  companion: 'idle',
  moreCompanions: true,
  theme: 'dark',
  window: { width: 1280, height: 900 },
  after: async (dom) => {
    await dom.sleep(800);
    setSpeak({ on: false, offered: true });
    await dom.sleep(200);
  },
};
export default s;
