import type { HarnessScenario } from '../types';

// The sidebar companion row: the Potato face and its live line.
const s: HarnessScenario = { name: 'companion-row', route: 'cockpit', companion: 'idle', after: async (dom) => { await dom.sleep(800); } };
export default s;
