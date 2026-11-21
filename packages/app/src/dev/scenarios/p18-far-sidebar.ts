import { MAC_MINI, NODE_MAC, type RemotePane } from '../devices-fixtures';
import type { HarnessScenario } from '../types';

// P1.8: the far project in the sidebar has the same header as a folder of this PC: the caret button, "New agent in", and "More". The PC
// has a long name (the founder's Linux PC), and the project's name stays whole. "More" is open: what cannot work there is greyed with
// one reason. (The two small buttons show on hover only; here they are forced on so a still picture can show them.)
const PANES: RemotePane[] = [{ id: 'p1', agent_type: 'claude', cwd: '/home/pm/work-test', status: 'idle', title: 'Check the build', lane: 'acp' }];
const s: HarnessScenario = {
  name: 'p18-far-sidebar',
  route: 'cockpit',
  window: { width: 1280, height: 800 },
  devices: { devices: [{ ...MAC_MINI, name: 'This computer (sandbox-test)', level: 'full' }], panes: { [NODE_MAC]: PANES } },
  after: async (dom) => {
    await dom.waitFor(`.ck-proj[data-remote-node="${NODE_MAC}"]`);
    const style = document.createElement('style');
    style.textContent = '.ck-proj-act{opacity:1 !important}';
    document.head.appendChild(style);
    await dom.sleep(300);
    await dom.click(`.ck-proj[data-remote-node="${NODE_MAC}"] .ck-proj-head button[aria-haspopup="menu"]`);
    await dom.waitFor('[role="menuitem"]');
    await dom.sleep(400);
  },
};
export default s;
