// Routines and Chains for the harness: what the mocked `routines_*` commands answer. Example data only. The shapes
// are `lib/routines.ts` (mirroring `routines/view.rs`).
import type { RoutinesView, WorkflowView } from '../lib/routines';

export interface RoutinesScenario {
  /** What `routines_view` answers. Default: the list with routines, one chain and a few runs. */
  view?: RoutinesView;
}

const H = 3_600_000;
const NOW = Date.now();

const MORNING: WorkflowView = {
  id: 'rt-0a1b2c3d',
  name: 'Morning check',
  kind: 'routine',
  enabled: true,
  days: [1, 2, 3, 4, 5],
  time: '09:00',
  paneId: null,
  onlyIfOk: false,
  steps: [
    { kind: 'start_agent', agent: 'claude', project: 'C:/work/shop', text: 'Look at yesterday and list what broke.', separateCopy: true },
    { kind: 'wait', agent: null, project: null, text: null, separateCopy: false },
    { kind: 'notify', agent: null, project: null, text: 'Morning check finished', separateCopy: false },
  ],
  nextMs: NOW + 5 * H,
  lastRunMs: NOW - 19 * H,
  lastResult: 'done',
  pausedNote: null,
  running: false,
};

const TIDY: WorkflowView = {
  ...MORNING,
  id: 'rt-1b2c3d4e',
  name: 'Friday tidy',
  days: [5],
  time: '17:30',
  enabled: false,
  pausedNote: 'paused_failed',
  nextMs: null,
  lastResult: 'failed',
  steps: [{ kind: 'start_agent', agent: 'codex', project: 'C:/work/api', text: 'Remove dead code.', separateCopy: true }, MORNING.steps[1]],
};

const CHAIN: WorkflowView = {
  ...MORNING,
  id: 'rt-2c3d4e5f',
  name: 'Then: send a message',
  kind: 'chain',
  days: [],
  time: null,
  paneId: 'pane-1',
  onlyIfOk: true,
  nextMs: null,
  lastRunMs: null,
  lastResult: null,
  steps: [{ kind: 'follow_up', agent: null, project: null, text: 'Now run the tests.', separateCopy: false }],
};

export const ROUTINES_LIST: RoutinesView = {
  limit: null,
  running: 1,
  workflows: [MORNING, TIDY, CHAIN],
  queue: [],
  runs: [
    { id: 'rr-00000001', workflowId: MORNING.id, name: 'Morning check', state: 'running', step: 1, stepCount: 3, noteCode: 'late', noteDetail: null, dueMs: NOW - 2 * H, createdMs: NOW - 5 * 60_000, finishedMs: null },
    { id: 'rr-00000002', workflowId: MORNING.id, name: 'Morning check', state: 'done', step: 3, stepCount: 3, noteCode: null, noteDetail: null, dueMs: null, createdMs: NOW - 19 * H, finishedMs: NOW - 18 * H },
    { id: 'rr-00000003', workflowId: TIDY.id, name: 'Friday tidy', state: 'failed', step: 0, stepCount: 2, noteCode: 'refused', noteDetail: 'That folder is not a project.', dueMs: null, createdMs: NOW - 70 * H, finishedMs: NOW - 70 * H },
  ],
};

/** At most 3 at once, 3 running, two routines waiting for a free slot. */
export const ROUTINES_QUEUE: RoutinesView = {
  ...ROUTINES_LIST,
  limit: 3,
  running: 3,
  queue: [
    { runId: 'rr-00000010', name: 'Morning check', position: 1 },
    { runId: 'rr-00000011', name: 'Friday tidy', position: 2 },
  ],
  runs: [
    { id: 'rr-00000010', workflowId: MORNING.id, name: 'Morning check', state: 'waiting', step: 0, stepCount: 3, noteCode: null, noteDetail: null, dueMs: null, createdMs: NOW - 60_000, finishedMs: null },
    { id: 'rr-00000011', workflowId: TIDY.id, name: 'Friday tidy', state: 'waiting', step: 0, stepCount: 2, noteCode: null, noteDetail: null, dueMs: null, createdMs: NOW - 30_000, finishedMs: null },
  ],
};

export function routinesMock(s: RoutinesScenario | undefined, cmd: string): { handled: boolean; value?: unknown } {
  if (!cmd.startsWith('routines_')) return { handled: false };
  switch (cmd) {
    case 'routines_view':
      return { handled: true, value: s?.view ?? ROUTINES_LIST };
    case 'routines_agents':
      return { handled: true, value: [{ id: 'claude', label: 'Claude Code' }, { id: 'codex', label: 'Codex' }] };
    case 'routines_create':
    case 'routines_run_now':
      return { handled: true, value: 'rt-00000000' };
    default:
      return { handled: true, value: null };
  }
}
