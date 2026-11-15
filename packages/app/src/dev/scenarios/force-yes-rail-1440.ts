import { PANE_CODEX } from '../fixtures';
import type { HarnessScenario } from '../types';
import { withChatItems } from './pane-polish-chat-items';

// Force yes in a chat's header with the session rail open: clicking Force yes shows its warning in the top layer, above the rail.
type Invoke = (cmd: string, args?: unknown, opts?: unknown) => Promise<unknown>;

const STATE = {
  lane: 'acp', agent: 'codex', label: 'Codex', phase: 'idle', status: 'idle', turnInFlight: false, stopping: false, canSteer: true,
  turn: 1, title: null, usage: null, permissions: [], closed: false, conversation: PANE_CODEX, inTerminal: null, agentAnswering: false,
  configOptions: [], commands: [], forceYes: false,
};

const s: HarnessScenario = {
  name: 'force-yes-rail-1440',
  route: 'cockpit',
  select: PANE_CODEX,
  window: { width: 1440, height: 900 },
  after: async (dom) => {
    withChatItems();
    const w = window as unknown as { __TAURI_INTERNALS__?: { invoke: Invoke } };
    const internals = w.__TAURI_INTERNALS__;
    if (internals) {
      const real = internals.invoke.bind(internals);
      internals.invoke = (cmd, args, opts) =>
        cmd === 'acp_chat_state' ? Promise.resolve(STATE) : cmd === 'pane_force_yes' ? Promise.resolve(false) : real(cmd, args, opts);
    }
    // The pane read its chat state before the mock was in place: select another pane and come back so it reads again.
    await dom.clickText('[data-pane-row]', 'Claude');
    await dom.sleep(500);
    await dom.clickText('[data-pane-row]', 'Codex');
    await dom.sleep(800);
    // Then switch tabs until the chip is there (a few tries).
    for (let i = 0; i < 4 && !document.querySelector('[data-testid="force-yes-chip"][data-on="false"]'); i++) {
      await dom.clickText('[role="tab"]', 'Terminal');
      await dom.sleep(300);
      await dom.clickText('[role="tab"]', 'Chat');
      await dom.waitFor('[data-testid="force-yes-chip"][data-on="false"]', 1500);
    }
    await dom.sleep(300);
    await dom.click('[data-testid="force-yes-chip"][data-on="false"]');
    await dom.waitFor('[data-testid="force-yes-warning"]');
    await dom.sleep(400);
  },
};
export default s;
