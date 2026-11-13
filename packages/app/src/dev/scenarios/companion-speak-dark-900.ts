import type { HarnessScenario } from '../types';
import { speakBubble } from '../companion-steps';

// Companion evidence: speak, dark, 900 px wide.
const s: HarnessScenario = {
  name: 'companion-speak-dark-900',
  route: 'cockpit',
  companion: 'idle',
  theme: 'dark',
  window: { width: 900, height: 700 },
  after: speakBubble,
};
export default s;
