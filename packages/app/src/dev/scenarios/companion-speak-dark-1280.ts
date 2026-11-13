import type { HarnessScenario } from '../types';
import { speakBubble } from '../companion-steps';

// Companion evidence: speak, dark, 1280 px wide.
const s: HarnessScenario = {
  name: 'companion-speak-dark-1280',
  route: 'cockpit',
  companion: 'idle',
  theme: 'dark',
  window: { width: 1280, height: 900 },
  after: speakBubble,
};
export default s;
