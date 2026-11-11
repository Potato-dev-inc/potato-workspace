import { teamConfig, teamState } from '../team-fixtures';
import type { HarnessScenario } from '../types';

// Settings > Team > Start: team name and your name, the recommended relay first, other ways folded.
const s: HarnessScenario = {
  name: 'team-page-start',
  route: 'settings',
  settingsTab: 'team',
  window: { width: 1100, height: 760 },
  team: teamState(),
  teamConfig: teamConfig({ enabled: false, team: '', teamName: '', relay: '', name: '', members: [], joins: [], admin: false, transport: null, link: null }),
  after: async (dom) => {
    await dom.waitFor('.st-team');
    await dom.clickText('.tp-choice', 'Start a team');
    const setValue = (el: Element | null, value: string) => {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
      el?.dispatchEvent(new Event('input', { bubbles: true }));
    };
    setValue(await dom.waitFor('input[placeholder="Acme"]'), 'Acme');
    await dom.sleep(250);
  },
};
export default s;
