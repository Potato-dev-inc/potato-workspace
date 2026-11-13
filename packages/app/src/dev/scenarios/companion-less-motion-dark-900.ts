import type { HarnessScenario } from '../types';
import { lessMotion } from '../companion-steps';

// Companion evidence: less-motion, dark, 900 px wide.
const s: HarnessScenario = {
  name: 'companion-less-motion-dark-900',
  route: 'cockpit',
  companion: 'idle',
  theme: 'dark',
  window: { width: 900, height: 700 },
  after: lessMotion,
};
export default s;
