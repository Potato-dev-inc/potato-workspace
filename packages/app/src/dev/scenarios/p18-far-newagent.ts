import { MAC_MINI, NODE_MAC, type RemotePane } from '../devices-fixtures';
import type { HarnessScenario } from '../types';

// P1.8: "New agent in work-test" on the far project opens the normal New agent page on that project and that PC; the "Run in" list has
// the account PC by its own name next to this PC's WSL places, labelled "WSL · ...".
const PANES: RemotePane[] = [{ id: 'p1', agent_type: 'claude', cwd: '/home/pm/work-test', status: 'idle', title: 'Check the build', lane: 'acp' }];
const s: HarnessScenario = {
  name: 'p18-far-newagent',
  route: 'cockpit',
  window: { width: 1280, height: 800 },
  devices: {
    devices: [{ ...MAC_MINI, name: 'This computer (sandbox-test)', level: 'full' }],
    panes: { [NODE_MAC]: PANES },
    projectsOf: { [NODE_MAC]: [{ id: 'p-/home/pm/work-test', name: 'work-test', state: 'repo' }] },
  },
  wsl: {
    status: {
      state: 'ready',
      distros: [
        { name: 'Ubuntu', default: true, version: 2, state: 'Running' },
        { name: 'pm-sbx-main', default: false, version: 2, state: 'Running' },
      ],
    },
  },
  after: async (dom) => {
    await dom.waitFor(`.ck-proj[data-remote-node="${NODE_MAC}"]`);
    await dom.click(`.ck-proj[data-remote-node="${NODE_MAC}"] .ck-proj-head button.ck-proj-act`);
    await dom.waitFor('[data-testid="na-on-device"]');
    await dom.sleep(800);
    await dom.click('[data-testid="where-pill"]');
    await dom.waitFor('.dev-where-menu');
    await dom.sleep(400);
  },
};
export default s;
