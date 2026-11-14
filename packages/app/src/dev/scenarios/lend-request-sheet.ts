import { LEND_MEMBERS, lendState } from '../lend-fixtures';
import { teamState } from '../team-fixtures';
import type { HarnessScenario } from '../types';

// Inbox > Team: "Request usage" opened. My other PC first ("My PCs"), then teammates; "What to borrow" lists the lender's
// profiles by name ("Work account · Claude · up to 8 hours · asks first"), then how long, reason, Ask.
const s: HarnessScenario = {
  name: 'lend-request-sheet',
  route: 'cockpit',
  team: teamState({ cards: [] }),
  teamConfig: { members: LEND_MEMBERS },
  lend: lendState(),
  after: async (dom) => {
    await dom.waitFor('[data-lend-entry="inbox"] button');
    await dom.click('[data-lend-entry="inbox"] button');
    await dom.waitFor('.lend-sheet');
    await dom.sleep(300);
  },
};
export default s;
