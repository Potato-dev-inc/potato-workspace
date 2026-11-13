import type { HarnessScenario } from '../types';
import { potatoDrop } from '../companion-steps';

// Companion evidence: potato-note, dark, 1280 px wide.
const s: HarnessScenario = {
  name: 'companion-potato-note-dark-1280',
  route: 'cockpit',
  companion: 'idle',
  theme: 'dark',
  window: { width: 1280, height: 900 },
  after: potatoDrop('note'),
};
export default s;
