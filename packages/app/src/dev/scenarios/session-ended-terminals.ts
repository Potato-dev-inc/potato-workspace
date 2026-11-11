import type { HarnessScenario } from '../types';
import { SESSION_MEMORY_KEY } from '../../components/cockpit/session-memory';

// Two terminal agents from the last run are gone: one calm line with Reopen and Dismiss.
const s: HarnessScenario = {
  name: 'session-ended-terminals',
  route: 'cockpit',
  storage: {
    [SESSION_MEMORY_KEY]: JSON.stringify({
      selected: null,
      terminals: [
        { id: 'gone-1', agent: 'claude', cwd: 'C:\Users\dev\work\potato-workspace' },
        { id: 'gone-2', agent: 'codex', cwd: 'C:\Users\dev\work\site' },
      ],
    }),
  },
  after: async (dom) => {
    await dom.waitFor('.ck-ended');
  },
};
export default s;
