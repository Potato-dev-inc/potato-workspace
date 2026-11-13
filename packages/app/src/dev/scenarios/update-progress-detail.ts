import type { HarnessScenario } from '../types';

// The update download with real numbers: "58 MB of 138 MB · 3.1 MB/s · about 26 seconds left".
const s: HarnessScenario = {
  name: 'update-progress-detail',
  route: 'settings',
  settingsTab: 'overview',
  after: async (dom) => {
    type Internals = { invoke: (cmd: string, args?: unknown, opts?: unknown) => Promise<unknown> };
    const internals = (window as unknown as { __TAURI_INTERNALS__: Internals }).__TAURI_INTERNALS__;
    const real = internals.invoke.bind(internals);
    internals.invoke = (cmd, args, opts) => {
      if (cmd === 'app_update_check') return Promise.resolve({ currentVersion: '1.0.24', version: '1.0.25', notes: null });
      if (cmd === 'app_update_busy') return Promise.resolve({ agents: [], chats: [], terminals: [] });
      if (cmd === 'app_update_install') return new Promise(() => undefined);
      return real(cmd, args, opts);
    };
    await dom.waitFor('button');
    (await dom.clickText('button', 'Check for updates')) || (await dom.clickText('button', '檢查更新'));
    await dom.waitFor('.app-update-notice');
    (await dom.clickText('.app-update-notice button', 'Update')) || (await dom.clickText('.app-update-notice button', '更新'));
    await dom.sleep(300);
    const MB = 1024 * 1024;
    const { emit } = await import('@tauri-apps/api/event');
    const send = (downloaded: number) => emit('app-update-progress', { downloaded, total: 138 * MB });
    await send(40 * MB);
    await dom.sleep(1000);
    await send(58 * MB);
    await dom.sleep(300);
  },
};
export default s;
