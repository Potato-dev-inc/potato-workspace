import type { HarnessScenario } from '../types';

// The sidebar footer at a wide window: a text label beside each icon, and Settings is a gear.
const s: HarnessScenario = { name: 'cockpit-footer-labels', route: 'cockpit', window: { width: 1440, height: 900 } };
export default s;
