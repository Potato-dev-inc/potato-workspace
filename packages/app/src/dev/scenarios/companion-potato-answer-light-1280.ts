import type { HarnessScenario } from '../types';
import { potatoDrop } from '../companion-steps';

// Companion evidence: potato-answer, light, 1280 px wide.
const s: HarnessScenario = {
  name: 'companion-potato-answer-light-1280',
  route: 'cockpit',
  companion: 'idle',
  theme: 'light',
  window: { width: 1280, height: 900 },
  after: potatoDrop('answer'),
};
export default s;
