import type { HarnessScenario } from '../types';
import { speakBubble } from '../companion-steps';

// Companion evidence: speak, light, 1280 px wide.
const s: HarnessScenario = {
  name: 'companion-speak-light-1280',
  route: 'cockpit',
  companion: 'idle',
  theme: 'light',
  window: { width: 1280, height: 900 },
  after: speakBubble,
};
export default s;
