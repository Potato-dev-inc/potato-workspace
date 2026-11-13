import type { HarnessScenario } from '../types';
import { potatoDrop } from '../companion-steps';

// Companion evidence: potato-note, dark, 900 px wide.
const s: HarnessScenario = {
  name: 'companion-potato-note-dark-900',
  route: 'cockpit',
  companion: 'idle',
  theme: 'dark',
  window: { width: 900, height: 700 },
  after: potatoDrop('note'),
};
export default s;
