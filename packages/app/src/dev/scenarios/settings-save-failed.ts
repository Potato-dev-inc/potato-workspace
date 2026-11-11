import type { HarnessScenario } from '../types';

// Settings > General when the settings file cannot be written: the switch snaps back and the row says "Not saved".
const s: HarnessScenario = {
  name: 'settings-save-failed',
  route: 'settings',
  settingsTab: 'general',
  after: async (dom) => {
    await dom.waitFor('button[role="switch"]');
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown, opts?: unknown) => Promise<unknown> } })
      .__TAURI_INTERNALS__;
    const real = internals.invoke.bind(internals);
    internals.invoke = (cmd, args, opts) => (cmd === 'settings_patch' ? Promise.reject('The settings file is read-only.') : real(cmd, args, opts));
    await dom.click('button[role="switch"]');
    await dom.waitFor('[role="alert"]');
    await dom.sleep(300);
  },
};
export default s;
