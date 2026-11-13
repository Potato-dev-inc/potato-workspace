import type { HarnessScenario } from '../types';

// No companion yet: one quiet line at the bottom of the sidebar.
const s: HarnessScenario = { name: 'companion-none', route: 'cockpit', after: async (dom) => { await dom.sleep(800); } };
export default s;
