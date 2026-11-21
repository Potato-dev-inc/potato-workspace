import { MAC_MINI, MAC_PANES, NODE_MAC } from '../devices-fixtures';
import type { HarnessScenario } from '../types';

// A terminal on the Mac mini, open in the main area: the NORMAL terminal (xterm, the same viewport as a local one), fed by the far PC's pane
// stream. The far PC here is a stub shell (`far-shell-stub.ts`), not a real pty: `uname -a` is typed into it.
const s: HarnessScenario = {
  name: 'devices-terminal-uname',
  route: 'cockpit',
  window: { width: 1280, height: 900 },
  devices: {
    devices: [{ ...MAC_MINI, needs_person: [{ pane: 'p2', what: 'a password box is open there' }] }],
    panes: { [NODE_MAC]: MAC_PANES },
  },
  after: async (dom) => {
    await dom.waitFor(`[data-pane-row="dev:${NODE_MAC}:p2"]`);
    await dom.click(`[data-pane-row="dev:${NODE_MAC}:p2"]`);
    await dom.waitFor('[data-testid="remote-terminal"] .pm-terminal-host');
    await dom.sleep(800);
    // Stands in for the person typing (the harness cannot press keys inside xterm): what is typed goes to the far PC as the real call does.
    const type = (text: string) => (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__.invoke('devices_request', { node: NODE_MAC, method: 'POST', path: '/pclink/call/write_pane_input', body: { paneId: 'p2', args: { text, append_newline: false } } });
    await type('uname -a\r');
    await dom.sleep(300);
    await dom.sleep(800);
  },
};
export default s;
