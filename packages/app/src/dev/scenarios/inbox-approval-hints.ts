import type { HarnessScenario } from '../types';

// The Inbox with a pane approval card: the card shows which keys answer it.
const s: HarnessScenario = {
  name: 'inbox-approval-hints',
  route: 'cockpit',
  after: async (dom) => {
    await dom.sleep(500);
  },
};
export default s;
