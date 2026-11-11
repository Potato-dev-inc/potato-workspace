import type { HarnessScenario } from '../types';

// Settings > General > Version: the installer could not start after the agents were stopped. The notice says so and
// offers to reopen the chats.
const s: HarnessScenario = {
  name: 'update-failed-after-stop',
  route: 'settings',
  settingsTab: 'general',
  after: async (dom) => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown, opts?: unknown) => Promise<unknown> } })
      .__TAURI_INTERNALS__;
    const real = internals.invoke.bind(internals);
    internals.invoke = (cmd, args, opts) => {
      if (cmd === 'app_update_check') return Promise.resolve({ currentVersion: '0.9.0', version: '0.9.1', notes: null });
      if (cmd === 'app_update_install') {
        return Promise.reject('UPDATE_STOPPED: Agents were stopped. The update could not be installed. Your current version keeps working.');
      }
      return real(cmd, args, opts);
    };
    await dom.waitFor('button');
    await dom.clickText('button', 'Check for updates');
    await dom.waitFor('.app-update-notice');
    await dom.clickText('.app-update-notice button', 'Update');
    await dom.waitFor('.app-update-notice[data-phase="stopped"]');
    await dom.sleep(300);
  },
};
export default s;
