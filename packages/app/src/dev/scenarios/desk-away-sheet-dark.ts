import type { HarnessScenario } from '../types';

// Leaving my desk on the PC: the chip in the status bar, opened to the sheet that asks how long.
const s: HarnessScenario = {
  name: 'desk-away-sheet-dark',
  route: 'cockpit',
  theme: 'dark',
  window: { width: 1100, height: 700 },
  usage: { rows: [] } as never,
  after: async (dom) => {
    await dom.waitFor('[data-testid="desk-chip"]', 15000);
    await dom.click('[data-testid="desk-chip"]');
    await dom.waitFor('[data-testid="desk-sheet"]');
    await dom.sleep(400);
  },
};
export default s;
