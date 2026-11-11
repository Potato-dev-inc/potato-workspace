// Shared by the first-run harness scenarios that start in a later step: walks the earlier ones with the
// same clicks a person makes, so the screenshot shows the real state and not a seeded one.
import { emit } from '@tauri-apps/api/event';
import type { PaneInfo } from '../lib/tauri-types';
import type { HarnessDom } from './types';

const created = Date.now() - 20_000;

/** The demo's agent (Claude) and the helper it started (Codex), both working. */
export function demoPanes(status: PaneInfo['status'] = 'running'): PaneInfo[] {
  return [
    { id: 'pane-new-1', agent_type: 'claude', pid: 101, status, created_at: created, last_output_at: created, cwd: 'D:\\code\\shop', cols: 120, rows: 32, title: 'Review the last commit' },
    { id: 'pane-helper-1', agent_type: 'codex', pid: 102, status, created_at: created + 8_000, last_output_at: created + 8_000, cwd: 'D:\\code\\shop', cols: 120, rows: 32, title: 'Review the last commit', parent_pane_id: 'pane-new-1' },
  ];
}

/** Agents found, connection already there, the recent repository picked: lands on Try it. */
export async function walkToTry(dom: HarnessDom): Promise<void> {
  await dom.waitFor('[data-testid="agent-rows"] li[data-state="ready"]');
  await dom.sleep(200);
  await dom.clickText('button', 'Continue');
  await dom.waitFor('[data-testid="connect-done"]');
  await dom.clickText('button', 'Continue');
  await dom.waitFor('.fr-row');
  await dom.clickText('.fr-row', 'shop');
  await dom.waitFor('[data-testid="picked-project"]');
  await dom.clickText('button', 'Continue');
  await dom.waitFor('[data-testid="task-prompt"]');
}

/** Flip the demo panes to idle, as they are when the answer is in. */
export async function finishDemo(panes: PaneInfo[]): Promise<void> {
  for (const p of panes) {
    p.status = 'idle';
    await emit('pty://status', { pane_id: p.id, status: 'idle' });
  }
}
