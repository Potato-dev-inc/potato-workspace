// Evidence scenarios for the helpers bar and drag to split (dev only). One main agent with helpers, a second main agent,
// and standby helpers; the drag scenarios press on a sidebar row and stop with the pointer held, so the screenshot shows
// the live preview (the half the chat takes, the half that stays, the centre line and the hint).
import type { PaneInfo } from '../lib/tauri-types';
import { setStandbys } from '../lib/helper-standbys';
import { dragTo } from './dndShots';
import { PANE_CLAUDE, PANE_CODEX, PANE_OPENCODE, PANE_PWSH } from './fixtures';
import type { HarnessDom, HarnessScenario } from './types';

const CWD = 'C:\\Users\\dev\\work\\potato-workspace';
const now = Date.now();
const pane = (id: string, agent: string, status: PaneInfo['status'], title: string, parent: string | null = null): PaneInfo => ({
  id,
  agent_type: agent,
  pid: 4000 + id.length,
  status,
  created_at: now - 600_000,
  last_output_at: now - 5_000,
  cwd: CWD,
  cols: 120,
  rows: 32,
  title,
  parent_pane_id: parent,
});

export const H_REVIEW = 'pane-helper-review';
export const H_TESTS = 'pane-helper-tests';
export const H_DOCS = 'pane-helper-docs';
export const PANES: PaneInfo[] = [
  pane(PANE_CLAUDE, 'claude', 'idle', 'Right panel rebuild'),
  pane(PANE_CODEX, 'codex', 'running', 'Fix usage duplicates'),
  pane(PANE_OPENCODE, 'opencode', 'idle', 'Word viewer pages'),
  pane(PANE_PWSH, 'claude', 'idle', 'Discord token store'),
  pane(H_REVIEW, 'codex', 'running', 'Reviewer', PANE_CLAUDE),
  pane(H_TESTS, 'claude', 'waiting_input', 'Tests', PANE_CLAUDE),
  pane(H_DOCS, 'gemini', 'idle', 'Docs', PANE_CLAUDE),
];

const standbys = () =>
  setStandbys([
    { id: 'sb-1', agent: 'codex', name: 'Reviewer', model: 'gpt-5', state: 'ready' },
    { id: 'sb-2', agent: 'claude', name: 'Quick fixer', state: 'ready' },
  ]);

const row = (id: string) => document.querySelector<HTMLElement>(`nav [data-pane-row="${id}"]`);

/** Press on a sidebar row and hold the pointer at (x, y) of the window. */
async function holdAt(dom: HarnessDom, id: string, x: number, y: number) {
  await dom.sleep(900);
  standbys();
  await dom.sleep(300);
  const from = row(id);
  if (from) await dragTo(dom, from, { x, y });
}

export type TopbarShot = 'bar' | 'mid' | 'right' | 'down' | 'replace';

export function topbarScenario(shot: TopbarShot, theme: 'dark' | 'light'): HarnessScenario {
  const split = shot === 'bar' || shot === 'replace';
  return {
    name: `topbar-${shot}-${theme}-1280`,
    route: 'cockpit',
    theme,
    window: { width: 1280, height: 760 },
    select: PANE_CLAUDE,
    panes: PANES,
    storage: split ? { 'pm.cockpit.split': JSON.stringify({ left: PANE_CLAUDE, right: PANE_CODEX, ratio: 0.5 }) } : {},
    after: async (dom) => {
      if (shot === 'bar') {
        await dom.sleep(900);
        standbys();
        await dom.sleep(400);
      } else if (shot === 'mid') await holdAt(dom, PANE_CODEX, 630, 300);
      else if (shot === 'right') await holdAt(dom, PANE_CODEX, 880, 300);
      else if (shot === 'down') await holdAt(dom, PANE_CODEX, 620, 600);
      else await holdAt(dom, PANE_OPENCODE, 380, 300);
    },
  };
}
