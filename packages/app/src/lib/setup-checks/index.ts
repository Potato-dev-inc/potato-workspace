// "Check my setup": runs every check and returns the rows in order. A check that cannot read its status shows
// "Can't check this yet" (warn) instead of failing the whole page. Only existing Tauri commands are used.
import { t } from '../../i18n';
import { tauriAcpAddonApi } from '../acpAddon';
import { agentHealthApi } from '../agent-health';
import { checkAddons } from './addons';
import { checkAgents } from './agents';
import { checkBridge } from './bridge';
import type { CheckRow, SetupCheckContext, SetupCheckDeps } from './types';

export type { CheckRow, CheckStatus, FixAction, FixKind, SetupCheckContext, SetupCheckDeps } from './types';
export { buildReport, redactReport } from './report';

export const tauriSetupDeps: SetupCheckDeps = {
  agentHealth: () => agentHealthApi.check(),
  addons: () => tauriAcpAddonApi.list(),
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

export async function runAllChecks(deps: SetupCheckDeps, ctx: SetupCheckContext): Promise<CheckRow[]> {
  const rows: CheckRow[] = [];
  rows.push(...(await step('bridge', () => checkBridge(ctx))));
  rows.push(...(await step('agents', async () => checkAgents(await deps.agentHealth()))));
  if (ctx.labs.acp_chat_enabled === true) {
    rows.push(...(await step('addons', async () => checkAddons(await deps.addons()))));
  }
  return rows;
}
