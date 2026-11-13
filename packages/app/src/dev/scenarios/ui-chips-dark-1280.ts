import type { HarnessScenario } from '../types';
import { exampleUsage } from '../usage-fixtures';

// Status bar groups (icon, percent, tiny bar, reset) and the three chip shapes: dark, 1280 wide.
const s: HarnessScenario = { name: 'ui-chips-dark-1280', route: 'cockpit', theme: 'dark', window: { width: 1280, height: 800 }, usage: exampleUsage() };
export default s;
