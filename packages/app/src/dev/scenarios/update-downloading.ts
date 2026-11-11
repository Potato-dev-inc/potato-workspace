import type { HarnessScenario } from '../types';

// Settings > General > Version: an update was found, Update was pressed, and the file is still coming in.
const s: HarnessScenario = {
  name: 'update-downloading',
  route: 'settings',
  settingsTab: 'general',
  after: async (dom) => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown, opts?: unknown) => Promise<unknown> } })
      .__TAURI_INTERNALS__;
    const real = internals.invoke.bind(internals);
    internals.invoke = (cmd, args, opts) => {
      if (cmd === 'app_update_check') return Promise.resolve({ currentVersion: '0.9.0', version: '0.9.1', notes: null });
      if (cmd === 'app_update_busy') return Promise.resolve({ agents: [], chats: [], terminals: [] });
      if (cmd === 'app_update_install') return new Promise(() => undefined); // never finishes: the download stays on screen
      return real(cmd, args, opts);
    };
    await dom.waitFor('button');
    await dom.clickText('button', 'Check for updates');
    await dom.waitFor('.app-update-notice');
    await dom.clickText('.app-update-notice button', 'Update');
    await dom.sleep(400);
  },
};
export default s;
