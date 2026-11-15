// Project budget, right-size line and the Speed report for the harness: what the mocked commands answer.
// Example numbers only; the shapes are `lib/tauri-types.ts` (the Rust views in `project_budget` and `flight::perf`).
import type { PerfSummary, ProjectBudgetLimits, ProjectBudgetStatus, RightSizeSuggestion } from '../lib/tauri-types';

export interface ProjectBudgetScenario {
  /** What `project_budget_status` answers (absent: the project has no limits). */
  status?: ProjectBudgetStatus;
  /** What `right_size_pending` answers (absent: nothing to say). */
  rightSize?: RightSizeSuggestion;
  /** What `project_budget_limits` answers. */
  limits?: ProjectBudgetLimits;
  /** What `perf_summary` answers. */
  perf?: PerfSummary;
}

export const REACHED: ProjectBudgetStatus = {
  limits: { turnsPerDay: 20, minutesPerDay: null, planPercent: null },
  usedTurns: 20,
  usedMinutes: 38,
  planPercent: null,
  reached: 'turns',
};

export const SMALL_TASK: RightSizeSuggestion = { kind: 'smaller', fromName: 'Opus', toValue: 'haiku', toName: 'Haiku' };

export const LIMITS: ProjectBudgetLimits = { turnsPerDay: 20, minutesPerDay: 90, planPercent: null };

const stat = (count: number, medianMs: number | null, lastMs: number | null) => ({ count, medianMs, lastMs });

export const PERF: PerfSummary = {
  appStart: stat(0, null, null),
  chatWarm: stat(6, 420, 380),
  chatCold: stat(3, 7400, 8100),
  handshake: stat(3, 3100, 3300),
  firstReply: stat(9, 2600, 2100),
  setupCheck: stat(2, 900, 850),
  warmHits: 6,
  warmMisses: 3,
  startupSteps: [
    { name: 'agent_definitions', stepMs: 180 },
    { name: 'mcp_resources', stepMs: 1450 },
    { name: 'bridge', stepMs: 320 },
    { name: 'acp_restore', stepMs: 90 },
  ],
  startupTotalMs: 3200,
};

/** `handled: false` leaves the command to the normal mock. */
export function projectBudgetMock(s: ProjectBudgetScenario | undefined, cmd: string): { handled: boolean; value?: unknown } {
  switch (cmd) {
    case 'project_budget_status':
      return { handled: true, value: s?.status ?? null };
    case 'project_budget_limits':
      return { handled: true, value: s?.limits ?? { turnsPerDay: null, minutesPerDay: null, planPercent: null } };
    case 'project_budget_set':
      return { handled: true, value: s?.limits ?? LIMITS };
    case 'right_size_pending':
      return { handled: true, value: s?.rightSize ?? null };
    case 'perf_summary':
      return { handled: true, value: s?.perf ?? null };
    default:
      return { handled: false };
  }
}
