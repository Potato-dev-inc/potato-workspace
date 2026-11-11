import type { HarnessScenario } from '../types';
import { exampleUsage } from '../usage-fixtures';

// The "Used" bar along the bottom of the cockpit: percent and reset per sign-in, Limited, Sign-in expired, Unknown.
const s: HarnessScenario = { name: 'cockpit-usage-bar', route: 'cockpit', window: { width: 1440, height: 900 }, usage: exampleUsage() };
export default s;
