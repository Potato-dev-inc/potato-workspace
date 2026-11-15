import type { HarnessScenario } from '../types';
import { drawBar } from '../agent-bar-shots';

// The agent browser's bar on top of a page: stopped.
const s: HarnessScenario = {
  name: 'agent-bar-stopped',
  route: 'cockpit',
  theme: 'light',
  window: { width: 900, height: 360 },
  after: (dom) => drawBar(dom, 'stopped'),
};
export default s;
