import { teamConfig, teamState } from '../team-fixtures';
import type { HarnessScenario } from '../types';

// Settings > Team after Join: waiting for the owner to let you in.
const s: HarnessScenario = {
  name: 'team-page-waiting',
  route: 'settings',
  settingsTab: 'team',
  window: { width: 1100, height: 760 },
  team: teamState(),
  teamConfig: teamConfig({ ...{ enabled: false, team: '', teamName: '', relay: '', name: '', members: [], joins: [], admin: false, transport: null, link: null }, joining: 'Acme' }),
  after: async (dom) => {
    await dom.waitFor('.st-team');
    await dom.sleep(250);
  },
};
export default s;
