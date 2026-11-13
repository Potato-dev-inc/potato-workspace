import type { HarnessScenario } from '../types';
import { lessMotion } from '../companion-steps';

// Companion evidence: less-motion, dark, 1280 px wide.
const s: HarnessScenario = {
  name: 'companion-less-motion-dark-1280',
  route: 'cockpit',
  companion: 'idle',
  theme: 'dark',
  window: { width: 1280, height: 900 },
  after: lessMotion,
};
export default s;
