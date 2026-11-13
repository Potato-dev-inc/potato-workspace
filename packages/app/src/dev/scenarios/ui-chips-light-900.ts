import type { HarnessScenario } from '../types';
import { exampleUsage } from '../usage-fixtures';

// Status bar groups (icon, percent, tiny bar, reset) and the three chip shapes: light, 900 wide.
const s: HarnessScenario = { name: 'ui-chips-light-900', route: 'cockpit', theme: 'light', window: { width: 900, height: 800 }, usage: exampleUsage() };
export default s;
