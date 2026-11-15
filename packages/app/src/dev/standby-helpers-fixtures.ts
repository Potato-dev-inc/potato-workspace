// Fixtures for the Standby helpers evidence scenarios: one ready, one working, one closed to save memory.
import type { StandbyHelpersView } from '../lib/standbyHelpers';

export const standbyHelpersView: StandbyHelpersView = {
  max: 4,
  idle_minutes: 30,
  helpers: [
    { id: 'sb-1', name: 'Reviewer', agent: 'codex', model: 'gpt-5', project: 'C:/work/app', after_task: 'wait', state: 'ready', note: null, pane_id: null },
    { id: 'sb-2', name: 'Tester', agent: 'claude', model: 'sonnet', project: 'C:/work/app', after_task: 'wait', state: 'busy', note: null, pane_id: 'chat-7' },
    { id: 'sb-3', name: 'Docs', agent: 'opencode', model: null, project: 'C:/work/docs', after_task: 'close', state: 'asleep', note: null, pane_id: null },
  ],
};
