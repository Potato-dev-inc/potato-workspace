// Evidence scenarios for the live view INSIDE the front agent's chat (Labs "Workflows"): the Workflow pane in the details column,
// the card at the top of a narrow chat, and the sidebar row (normal and hovered). One factory, light and dark.
import type { PaneInfo } from '../lib/tauri-types';
import type { HarnessScenario } from './types';

export type DockMoment = 'pane' | 'card' | 'sidebar' | 'sidebar-hover';

const T = Date.now();
const pane = (id: string, over: Partial<PaneInfo>): PaneInfo => ({ id, agent_type: 'claude', pid: 1, status: 'idle', created_at: T, last_output_at: null, cwd: 'C:\\work\\demo', cols: 100, rows: 30, ...over });
const front = pane('wf-front', { status: 'running', created_at: T - 600_000, title: 'Research and write' });
const helper = (id: string, task: string, status: PaneInfo['status'], ago: number, as: 'minion' | 'spin_off') =>
  pane(id, { status, created_at: T - ago, parent_pane_id: 'wf-front', started_as: as, origin: { host: 'Claude', task } });

export const DOCK_PANES: PaneInfo[] = [
  front,
  helper('h-hard', 'fix the hard login test', 'running', 130_000, 'minion'),
  helper('h-easy', 'update the easy readme', 'waiting_input', 25_000, 'spin_off'),
  pane('other', { title: 'Check the docs build', status: 'idle', created_at: T - 3_600_000 }),
];

/** The same real hover look, taken from the app's own stylesheet (CSS cannot be hovered from a script). */
function forceHover(el: Element): void {
  const style = document.createElement('style');
  let css = '';
  for (const sheet of [...document.styleSheets]) {
    try {
      for (const rule of [...sheet.cssRules]) if (rule instanceof CSSStyleRule && rule.selectorText.includes('.ck-row:hover')) css += `${rule.selectorText.replace(/:hover/g, '.is-forced-hover')}{${rule.style.cssText}}`;
    } catch {
      /* a sheet from another origin */
    }
  }
  style.textContent = css;
  document.head.appendChild(style);
  el.classList.add('is-forced-hover');
}

export function dockScenario(moment: DockMoment, theme: 'light' | 'dark'): HarnessScenario {
  const narrow = moment === 'card';
  return {
    name: `workflow-dock-${moment}-${theme}`,
    route: 'cockpit',
    theme,
    workflows: true,
    window: narrow ? { width: 900, height: 800 } : { width: 1500, height: 900 },
    panes: DOCK_PANES,
    select: 'wf-front',
    storage: {
      'pm.crew.members': JSON.stringify({ 'wf-front': { slug: 'haiku-router', role: 'Front', front: true, name: 'Research + Write' } }),
      'pm.sidebar.groupBy': 'status',
      ...(narrow ? { 'pm.sessionRail.open': '0' } : {}),
    },
    after: async (dom) => {
      if (moment === 'pane') {
        await dom.waitFor('[data-testid="wf-live"]', 6000);
        await dom.sleep(700);
      } else if (moment === 'card') {
        await dom.clickText('button', 'Chat');
        await dom.waitFor('[data-testid="wf-card-head"]', 6000);
        await dom.click('[data-testid="wf-card-head"]');
        await dom.sleep(700);
      } else {
        const row = await dom.waitFor('[data-testid="workflow-row"] button', 6000);
        if (moment === 'sidebar-hover' && row) forceHover(row);
        await dom.sleep(500);
      }
    },
  };
}
