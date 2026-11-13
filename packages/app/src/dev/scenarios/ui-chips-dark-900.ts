import type { HarnessScenario } from '../types';
import { exampleUsage } from '../usage-fixtures';

// Status bar groups (icon, percent, tiny bar, reset) and the three chip shapes: dark, 900 wide.
const s: HarnessScenario = { name: 'ui-chips-dark-900', route: 'cockpit', theme: 'dark', window: { width: 900, height: 800 }, usage: exampleUsage() };
export default s;
