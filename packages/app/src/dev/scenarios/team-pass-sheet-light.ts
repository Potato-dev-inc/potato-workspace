import { teamPageLend, teamPageState } from '../team-page-fixtures';
import { tasksView } from '../team-tasks-fixtures';
import type { HarnessScenario } from '../types';

// Pass a task sheet over the Team page: the repo chosen, so the own-risk box shows, light theme.
const s: HarnessScenario = {
  name: 'team-pass-sheet-light',
  route: 'cockpit',
  theme: 'light',
  window: { width: 1100, height: 1300 },
  team: teamPageState(),
  lend: teamPageLend(),
  tasks: tasksView(),
  after: async (dom) => {
    const set = (sel: string, value: string) => {
      const el = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(sel)!;
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    await dom.waitFor('[data-testid="side-team"]');
    await dom.click('[data-testid="side-team"]');
    await dom.waitFor('[data-testid="pass-task-m-maya"]');
    await dom.click('[data-testid="pass-task-m-maya"]');
    await dom.waitFor('[data-testid="pass-title"]');
    set('[data-testid="pass-title"]', 'Fix the stable link sheet');
    set('[data-testid="pass-text"]', 'The address is cut at 320 px. Please make it wrap, and check it in the dark theme too.');
    await dom.click('[data-testid="pass-pick"]');
    await dom.sleep(300);
    await dom.click('[data-testid="pass-repo"]');
    await dom.sleep(500);
  },
};
export default s;
