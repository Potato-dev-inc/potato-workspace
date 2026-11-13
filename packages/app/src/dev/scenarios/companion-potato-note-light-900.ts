import type { HarnessScenario } from '../types';
import { potatoDrop } from '../companion-steps';

// Companion evidence: potato-note, light, 900 px wide.
const s: HarnessScenario = {
  name: 'companion-potato-note-light-900',
  route: 'cockpit',
  companion: 'idle',
  theme: 'light',
  window: { width: 900, height: 700 },
  after: potatoDrop('note'),
};
export default s;
