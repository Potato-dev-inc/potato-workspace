// "Check my setup": runs every check and returns the rows in order. A check that cannot read its status shows
// "Can't check this yet" (warn) instead of failing the whole page. Only existing Tauri commands are used.
import { t } from '../../i18n';
import { tauriAcpAddonApi } from '../acpAddon';
import { agentHealthApi } from '../agent-health';
import { checkAddons } from './addons';
import { checkAgents } from './agents';
import { checkBridge } from './bridge';
import { loadTestMemory } from './test-memory';
import type { CheckRow, SetupCheckContext, SetupCheckDeps } from './types';

export type { CheckRow, CheckStatus, FixAction, FixKind, SetupCheckContext, SetupCheckDeps } from './types';
export { buildReport, redactReport } from './report';
export { loadTestMemory, rememberTest, type TestMemory } from './test-memory';

export const tauriSetupDeps: SetupCheckDeps = {
  agentHealth: () => agentHealthApi.check(),
  addons: () => tauriAcpAddonApi.list(),
  tests: loadTestMemory,
};

/** The English sentence (kept for tests and for matching); the row itself carries `cantCheckText()`. */
export const CANT_CHECK_YET = "Can't check this yet"; // i18n-ok: English id, shown through cantCheckText()

/** The sentence in the person's language. */
export const cantCheckText = (): string => t('settings.card.cantCheck');

/** True for the "Can't check this yet" sentence in any language. */
export const isCantCheck = (sentence: string): boolean => sentence === CANT_CHECK_YET || sentence === cantCheckText();

/** The row a check shows when its status could not be read. */
export function cantCheck(id: string): CheckRow {
  return { id, status: 'warn', sentence: cantCheckText(), fix: null };
}

async function step(id: string, run: () => Promise<CheckRow[]> | CheckRow[]): Promise<CheckRow[]> {
  try {
    return await run();
  } catch {
    return [cantCheck(id)];
  }
}

/** The checks, one group each. Groups run side by side and report one by one, so fast ones show first. */
export type CheckGroupId = 'bridge' | 'agents' | 'addons';

export interface GroupResult {
  id: CheckGroupId;
  rows: CheckRow[];
  /** How long the group took, in milliseconds (the page logs it, so a slow check is easy to find). */
  ms: number;
  timedOut: boolean;
}

export interface RunOptions {
  /** Called first, with the checks that are about to run, in list order. */
  onStart?: (ids: CheckGroupId[]) => void;
  /** Called once per group, the moment it is done. */
  onGroup?: (group: GroupResult) => void;
  /** A group that has not answered by then says so instead of hanging. */
  timeoutMs?: number;
}

/** Longest a single check may take before its row says it did not answer. */
export const CHECK_TIMEOUT_MS = 8000;

/** The groups that run for this context, in the order their rows are listed. */
export function groupsFor(ctx: SetupCheckContext): CheckGroupId[] {
  return ctx.labs.acp_chat_enabled === true ? ['bridge', 'agents', 'addons'] : ['bridge', 'agents'];
}

/** The row for a check that did not answer in time: says why, and what to do. */
export function timedOutRow(id: CheckGroupId): CheckRow {
  return { id: `${id}-slow`, status: 'warn', sentence: t('overview.check.tooSlow', { name: t(`overview.check.group.${id}`) }), fix: null };
}

async function runGroup(id: CheckGroupId, work: () => Promise<CheckRow[]> | CheckRow[], timeoutMs: number): Promise<GroupResult> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), timeoutMs);
  });
  try {
    const out = await Promise.race([step(id, work), late]);
    return out === 'late' ? { id, rows: [timedOutRow(id)], ms: Date.now() - started, timedOut: true } : { id, rows: out, ms: Date.now() - started, timedOut: false };
  } finally {
    clearTimeout(timer);
  }
}

export async function runAllChecks(deps: SetupCheckDeps, ctx: SetupCheckContext, options: RunOptions = {}): Promise<CheckRow[]> {
  const timeoutMs = options.timeoutMs ?? CHECK_TIMEOUT_MS;
  const work: Record<CheckGroupId, () => Promise<CheckRow[]> | CheckRow[]> = {
    bridge: () => checkBridge(ctx),
    agents: async () => checkAgents(await deps.agentHealth(), deps.tests?.() ?? {}),
    addons: async () => checkAddons(await deps.addons()),
  };
  const ids = groupsFor(ctx);
  options.onStart?.(ids);
  const results = await Promise.all(
    ids.map(async (id) => {
      const group = await runGroup(id, work[id], timeoutMs);
      options.onGroup?.(group);
      return group;
    }),
  );
  return results.flatMap((g) => g.rows);
}
