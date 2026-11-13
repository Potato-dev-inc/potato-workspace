import type { HarnessScenario } from '../types';
import { potatoDrop } from '../companion-steps';

// Companion evidence: potato-answer, dark, 900 px wide.
const s: HarnessScenario = {
  name: 'companion-potato-answer-dark-900',
  route: 'cockpit',
  companion: 'idle',
  theme: 'dark',
  window: { width: 900, height: 700 },
  after: potatoDrop('answer'),
};
export default s;
