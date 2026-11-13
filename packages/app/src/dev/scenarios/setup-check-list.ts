import type { HarnessScenario } from '../types';

// Settings > Agents > Check my setup (1.0.25 founder report): five installed agents, one missing. Test was pressed on
// Claude (it answered, so it says when), and OpenCode / Aider cannot be tested so they say why and offer Open it.
const s: HarnessScenario = {
  name: 'setup-check-list',
  route: 'settings',
  settingsTab: 'setup-check',
  window: { width: 1100, height: 760 },
  after: async (dom) => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown, opts?: unknown) => Promise<unknown> } })
      .__TAURI_INTERNALS__;
    const real = internals.invoke.bind(internals);
    const row = (id: string, label: string, over: Record<string, unknown> = {}) => ({
      id, label, state: 'unchecked', installed: true, version: '1.0', reason: 'Installed.', install_hint: null, login_hint: null, can_test: true, ...over,
    });
    try {
      window.localStorage.setItem('pm.setupcheck.tests.v1', JSON.stringify({ claude: { state: 'ready', reason: 'Ready.', at: new Date(2026, 10, 13, 14, 5).getTime() } }));
    } catch {
      /* ignore */
    }
    internals.invoke = (cmd, args, opts) => {
      if (cmd === 'agents_health') {
        return Promise.resolve({
          agents: [
            row('claude', 'Claude'),
            row('codex', 'Codex CLI'),
            row('opencode', 'OpenCode', { can_test: false }),
            row('cursor_agent', 'Cursor Agent CLI'),
            row('aider', 'Aider', { can_test: false }),
            row('gemini', 'Gemini CLI', { installed: false, state: 'not_installed', reason: 'Not installed on this computer.' }),
          ],
        });
      }
      return real(cmd, args, opts);
    };
    await dom.sleep(900);
  },
};
export default s;
