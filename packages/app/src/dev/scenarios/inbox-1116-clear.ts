import { EXAMPLE_PANES, PANE_CLAUDE, PANE_CODEX, PANE_OPENCODE, PANE_PWSH } from '../fixtures';
import { teamState } from '../team-fixtures';
import type { TurnSummary } from '../../lib/cockpit-api';
import type { HarnessScenario } from '../types';

// Inbox 1.1.1, nothing needs you: the one calm line, "Done today" and "Team activity".
const now = Date.now();
const midnight = new Date(now).setHours(0, 0, 0, 0);
const ago = (min: number) => Math.max(midnight + 60_000, now - min * 60_000);
const turn = (paneId: string, agent: string, endedAtMs: number, files: TurnSummary['files'], extra: Partial<TurnSummary> = {}): TurnSummary => ({
  paneId,
  agent,
  turn: 1,
  startedAtMs: endedAtMs - 120_000,
  endedAtMs,
  durationMs: 120_000,
  files,
  approvals: [],
  end: { kind: 'idle' },
  sentence: 'Done.',
  ...extra,
});

export const INBOX_TURNS: Record<string, TurnSummary[]> = {
  [PANE_CLAUDE]: [turn(PANE_CLAUDE, 'claude', ago(20), { count: 12, added: 1204, deleted: 998, paths: [] }, { receipt: { checks: '2 of 2 checks pass', outcome: 'ok' } })],
  [PANE_CODEX]: [turn(PANE_CODEX, 'codex', ago(75), { count: 3, added: 310, deleted: 42, paths: [] })],
  [PANE_OPENCODE]: [turn(PANE_OPENCODE, 'opencode', ago(140), null)],
  [PANE_PWSH]: [],
};

const s: HarnessScenario = {
  name: 'inbox-1116-clear',
  route: 'cockpit',
  window: { width: 1280, height: 800 },
  panes: EXAMPLE_PANES.map((p) => ({ ...p, status: 'idle' as const })),
  turnSummaries: INBOX_TURNS,
  team: teamState(),
  after: async (dom) => {
    await dom.waitFor('[data-testid="team-activity"] [data-team-activity]');
    await dom.sleep(300);
  },
};
export default s;
