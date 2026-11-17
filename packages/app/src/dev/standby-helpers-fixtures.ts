// Fixtures for the Standby helpers evidence scenarios (the sidebar rows, the Add a helper popover, the take-over banner, Settings).
// They sit under the agents of `fixtures-sidebar.ts` (project potato-workspace).
import type { StandbyHelpersView } from '../lib/standbyHelpers';

const PROJECT = 'C:/Users/dev/work/potato-workspace';
const base = { note: null, pane_id: null, used_by: null, taken_over: false, open_pane: null, person_pane: null, after_task: 'wait' as const };

export const standbyHelpersView: StandbyHelpersView = {
  max: 6,
  idle_minutes: 30,
  helpers: [
    { ...base, id: 'sb-1', name: 'Reviewer', agent: 'codex', model: 'gpt-5', project: PROJECT, state: 'ready', home: 'sb-rework' },
    { ...base, id: 'sb-2', name: 'Docs', agent: 'opencode', model: null, project: PROJECT, state: 'asleep', home: 'sb-rework', after_task: 'close' },
    { ...base, id: 'sb-3', name: 'Claude · sonnet', agent: 'claude', model: 'sonnet', project: PROJECT, state: 'starting', stage: 'opening session', home: 'sb-login' },
    // An agent took this one while the person was using it in "Write release notes" (sb-notes): its task runs in the chat sb-helper.
    { ...base, id: 'sb-4', name: 'Tester', agent: 'claude', model: 'sonnet', project: PROJECT, state: 'busy', home: 'sb-rework', used_by: 'agent', taken_over: true, pane_id: 'sb-helper', person_pane: 'sb-notes' },
  ],
};
