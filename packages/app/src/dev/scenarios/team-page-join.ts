import { teamConfig, teamState } from '../team-fixtures';
import type { HarnessScenario } from '../types';

// Settings > Team > Join: an invite pasted with a message around it is found; name filled in; the code is the last thing to type.
const s: HarnessScenario = {
  name: 'team-page-join',
  route: 'settings',
  settingsTab: 'team',
  window: { width: 1100, height: 760 },
  team: teamState(),
  teamConfig: teamConfig({ enabled: false, team: '', teamName: '', relay: '', name: '', members: [], joins: [], admin: false, transport: null, link: null }),
  after: async (dom) => {
    await dom.waitFor('.st-team');
    await dom.clickText('.tp-choice', 'Join a team');
    const setValue = (el: Element | null, value: string) => {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
      el?.dispatchEvent(new Event('input', { bubbles: true }));
    };
    setValue(await dom.waitFor('textarea[aria-label="Invite link"]'), 'Hi Leo! Join our team here: pm://team/join?v=1&t=team-7f3a&n=Acme&k=8Vh2mQ0pXn4c. The code comes in the next message.');
    await dom.sleep(150);
    setValue(document.querySelector('input[placeholder="ABCD-EFGH"]'), 'kq7m4xpd');
    await dom.sleep(250);
  },
};
export default s;
