import { PANE_CLAUDE } from '../fixtures';
import { GRANT_IN_REN, lendState } from '../lend-fixtures';
import type { HarnessScenario } from '../types';

// A pane running on a borrowed sign-in: the time-left chip ("Ren's Work account · not answering") opened. Its title is the
// full name ("Claude · Ren's Work account (borrowed)"); when the lender's PC does not answer, the details say "Ren's PC is
// not answering. It may be asleep or offline. The time keeps running."
const s: HarnessScenario = {
  name: 'lend-pane-chip',
  route: 'cockpit',
  select: PANE_CLAUDE,
  lend: lendState({ grants: [{ ...GRANT_IN_REN, pane_ids: [PANE_CLAUDE], problem: 'x', problem_kind: 'unreachable' }] }),
  after: async (dom) => {
    await dom.waitFor('[data-testid="lend-chip"]');
    await dom.click('[data-testid="lend-chip"]');
    await dom.waitFor('.lend-pop');
    await dom.sleep(300);
  },
};
export default s;
