// Evidence scenarios for the live view of a workflow (Settings > Crews > a workflow > Live). One factory, five moments, two themes.
import { emit } from '@tauri-apps/api/event';
import type { PaneInfo } from '../lib/tauri-types';
import type { HarnessScenario } from './types';

export type LiveMoment = 'idle' | 'working' | 'needs-you' | 'failed' | 'log';

const T = Date.now();
const pane = (id: string, over: Partial<PaneInfo>): PaneInfo => ({ id, agent_type: 'claude', pid: 1, status: 'idle', created_at: T, last_output_at: null, cwd: 'C:\work\demo', cols: 100, rows: 30, ...over });
const front = (status: PaneInfo['status']) => pane('wf-front', { status, created_at: T - 600_000, title: 'Router' });
const helper = (id: string, task: string, status: PaneInfo['status'], ago: number) =>
  pane(id, { status, created_at: T - ago, parent_pane_id: 'wf-front', started_as: 'minion', origin: { host: 'Claude', task } });

export function liveScenario(moment: LiveMoment, theme: 'light' | 'dark'): HarnessScenario {
  const panes: PaneInfo[] = [];
  const set = (...next: PaneInfo[]) => panes.splice(0, panes.length, ...next);
  if (moment === 'idle') set(front('idle'));
  else if (moment === 'working') set(front('running'));
  else if (moment === 'needs-you') set(front('running'), helper('h-hard', 'fix the hard login test', 'running', 72_000), helper('h-easy', 'update the easy readme', 'waiting_input', 25_000));
  else if (moment === 'failed') set(front('idle'), helper('h-hard', 'fix the hard login test', 'error', 90_000), helper('h-easy', 'update the easy readme', 'idle', 40_000));
  else set(front('running'), helper('h-hard', 'fix the hard login test', 'running', 130_000), helper('h-easy', 'update the easy readme', 'waiting_input', 25_000));
  const changed = async () => emit('pty://panes-changed', { changed: true });
  return {
    name: `workflow-live-${moment}-${theme}`,
    route: 'settings',
    theme,
    workflows: true,
    settingsTab: 'crews-page',
    panes,
    window: { width: 1280, height: 800 },
    after: async (dom) => {
      // The settings route does not apply `storage`: remember the front chat before the canvas opens.
      window.localStorage.setItem('pm.crew.members', JSON.stringify({ 'wf-front': { slug: 'haiku-router', role: 'Front', front: true } }));
      // Settings shown inside the cockpit has no ?settings=1 (the separate window does, and has no Live tab).
      window.history.replaceState(null, '', window.location.pathname);
      document.documentElement.style.setProperty('--bg', getComputedStyle(document.body).backgroundColor);
      await dom.clickText('button', 'Open the canvas');
      await dom.waitFor('[data-testid="crew-box"]');
      await dom.sleep(500);
      await dom.clickText('[role="tab"]', 'Live');
      await dom.sleep(700);
      if (moment === 'working') {
        // One helper starts now: its dot is on the way down the arrow.
        panes.push(helper('h-hard', 'fix the hard login test', 'running', 2_000));
        await changed();
        // Freeze one frame of the real dot about halfway down (a copy of the element the canvas drew, set to 50% of its way), so the picture shows it.
        const dot = (await dom.waitFor('[data-testid="live-dot"]', 3000)) as HTMLElement | null;
        if (dot?.parentElement) {
          const frozen = dot.cloneNode(true) as HTMLElement;
          frozen.removeAttribute('data-testid');
          frozen.style.animation = 'none';
          frozen.style.offsetDistance = '50%';
          frozen.style.opacity = '1';
          dot.parentElement.appendChild(frozen);
        }
        await dom.sleep(300);
      } else if (moment === 'log') {
        // The hard one reports back (its dot goes up and is gone), so the log tells the whole story.
        panes.splice(1, 1, helper('h-hard', 'fix the hard login test', 'idle', 130_000));
        await changed();
        await dom.sleep(2200);
      }
    },
  };
}
