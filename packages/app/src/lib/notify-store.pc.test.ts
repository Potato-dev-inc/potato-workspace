// @vitest-environment jsdom
// In the desktop app the PC holds the choices: old browser-storage choices move there once, and a pick is sent to the PC.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BELL_KEY, QUIET_KEY, loadNotifyPrefs, readBells, readQuiet, resetNotifyStoreForTest, writeBell } from './notify-store';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

const PREFS = { bells: {}, quiet: { enabled: false, start: 1320, end: 420 }, snoozes: {}, imported: false };

beforeEach(() => {
  (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
  localStorage.clear();
  resetNotifyStoreForTest();
  invoke.mockReset();
});

describe('notification store on the PC', () => {
  it('moves old browser choices to the PC once, then forgets them', async () => {
    localStorage.setItem(BELL_KEY, JSON.stringify({ codex: 'silent', bad: 'loud' }));
    localStorage.setItem(QUIET_KEY, JSON.stringify({ enabled: true, start: 60, end: 120 }));
    invoke.mockImplementation(async (cmd: string) =>
      cmd === 'notify_prefs_get' ? PREFS : { ...PREFS, imported: true, bells: { codex: 'silent' }, quiet: { enabled: true, start: 60, end: 120 } },
    );
    await loadNotifyPrefs();
    expect(invoke).toHaveBeenCalledWith('notify_prefs_import', { bells: { codex: 'silent' }, quiet: { enabled: true, start: 60, end: 120 } });
    expect(localStorage.getItem(BELL_KEY)).toBeNull();
    expect(readBells()).toEqual({ codex: 'silent' });
    expect(readQuiet().enabled).toBe(true);
  });

  it('does not import again once the PC has its own choices', async () => {
    localStorage.setItem(BELL_KEY, JSON.stringify({ codex: 'silent' }));
    invoke.mockResolvedValue({ ...PREFS, imported: true, bells: { claude: 'finished' } });
    await loadNotifyPrefs();
    expect(invoke).not.toHaveBeenCalledWith('notify_prefs_import', expect.anything());
    expect(readBells()).toEqual({ claude: 'finished' });
  });

  it('a pick shows at once and is sent to the PC; the page storage is not written', () => {
    invoke.mockResolvedValue(null);
    writeBell('codex', 'needs');
    expect(readBells()).toEqual({ codex: 'needs' });
    expect(invoke).toHaveBeenCalledWith('notify_bell_set', { key: 'codex', level: 'needs' });
    expect(localStorage.getItem(BELL_KEY)).toBeNull();
  });

  it('an unreachable PC leaves the defaults and never throws', async () => {
    invoke.mockRejectedValue(new Error('no'));
    await expect(loadNotifyPrefs()).resolves.toBeUndefined();
    expect(readBells()).toEqual({});
  });
});
