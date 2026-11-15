import { teamConfig, teamState } from '../team-fixtures';
import type { HarnessScenario } from '../types';

// Settings > Team > Join: a one-time invite link (https://<worker>/join/<code>) pasted; the "Join Acme crew?" popup says who invited and what joining shares.
const s: HarnessScenario = {
  name: 'team-page-join-link',
  route: 'settings',
  settingsTab: 'team',
  window: { width: 1100, height: 760 },
  team: teamState(),
  teamConfig: teamConfig({ enabled: false, team: '', teamName: '', relay: '', name: '', members: [], joins: [], admin: false, transport: null, link: null }),
  after: async (dom) => {
    await dom.waitFor('.st-team');
    await dom.clickText('.tp-choice', 'Join a team');
    const box = await dom.waitFor('textarea[aria-label="Invite link"]');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(box ?? null, 'Join us: https://pm-relay.acme.workers.dev/join/KQ7M4XPDH5WZ9RTB');
    box?.dispatchEvent(new Event('input', { bubbles: true }));
    await dom.sleep(200);
    await dom.clickText('button', 'Look at this invite');
    await dom.waitFor('[data-testid="join-popup"] [data-testid="join-host"]');
    await dom.sleep(300);
  },
};
export default s;
