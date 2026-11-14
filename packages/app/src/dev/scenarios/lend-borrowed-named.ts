import { GRANT_IN_REN, GRANT_OUT, lendState } from '../lend-fixtures';
import type { HarnessScenario } from '../types';

// Settings > Lend > Active lends with the lender's names: "Claude · Ren's Work account (borrowed)" on the borrower's side,
// "Lending Work account to Maya" on the lender's, and "Take back" / "Give back".
const s: HarnessScenario = {
  name: 'lend-borrowed-named',
  route: 'settings',
  settingsTab: 'lend',
  window: { width: 900, height: 900 },
  lend: lendState({ profiles: [], grants: [{ ...GRANT_OUT, profile_name: 'Work account' }, { ...GRANT_IN_REN, pane_ids: [] }] }),
  after: async (dom) => {
    await dom.waitFor('.lend-page');
    await dom.waitFor('section[aria-label="Active lends"] li');
    await dom.sleep(400);
  },
};
export default s;
