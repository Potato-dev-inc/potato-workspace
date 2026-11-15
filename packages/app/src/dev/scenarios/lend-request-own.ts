import { MAC_MINI, WORK_LAPTOP } from '../devices-fixtures';
import { LEND_MEMBERS, lendState } from '../lend-fixtures';
import { teamState } from '../team-fixtures';
import type { HarnessScenario } from '../types';

// Settings > Team > Request usage with my other PCs taken from the Devices list: the Mac mini lets me borrow (a choice, no team
// needed), the Work laptop does not (one plain line says what to turn on).
const s: HarnessScenario = {
  name: 'lend-request-own',
  route: 'settings',
  settingsTab: 'team',
  window: { width: 1100, height: 1000 },
  team: teamState(),
  teamConfig: { members: LEND_MEMBERS, joins: [] },
  lend: lendState(),
  devices: { devices: [{ ...MAC_MINI, lets_lend: true }, { ...WORK_LAPTOP, lets_lend: false }] },
  after: async (dom) => {
    await dom.waitFor('[data-lend-entry="settings"] button');
    await dom.click('[data-lend-entry="settings"] button');
    await dom.waitFor('.lend-sheet');
    await dom.waitFor('[data-testid="lend-turn-on"]');
    await dom.sleep(300);
  },
};
export default s;
