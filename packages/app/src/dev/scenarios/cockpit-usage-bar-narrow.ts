import type { HarnessScenario } from '../types';
import { exampleUsage } from '../usage-fixtures';

// The "Used" bar in a narrow window: chips that do not fit collapse into "+N", on one line.
const s: HarnessScenario = { name: 'cockpit-usage-bar-narrow', route: 'cockpit', window: { width: 560, height: 600 }, usage: exampleUsage() };
export default s;
