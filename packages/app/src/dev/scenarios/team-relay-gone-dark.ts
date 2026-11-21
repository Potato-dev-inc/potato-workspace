import { setLanguagePref } from '../../i18n';
import { teamConfig, teamState } from '../team-fixtures';
import type { HarnessScenario } from '../types';

// Connect > Team when the relay the team was saved on is gone (Cloudflare: no Worker at that address).
const s: HarnessScenario = {
  name: 'team-relay-gone-dark',
  route: 'cockpit',
  theme: 'dark',
  tunnel: 'stable',
  team: teamState({ link: 'offline', linkDetail: { host: 'pm-relay-mnrw.example.workers.dev', step: 'waiting', attempting: false, problem: 'relay_gone', retryInS: null } }),
  teamConfig: teamConfig({ admin: true }),
  window: { width: 1280, height: 800 },
  after: async (dom) => {

    await dom.waitFor('[data-testid="side-connect"]');
    await dom.click('[data-testid="side-connect"]');
    await dom.click('[data-testid="connect-tab-team"]');
    await dom.waitFor('[data-testid="team-link-why"]');
    await dom.sleep(700);
  },
};
export default s;
