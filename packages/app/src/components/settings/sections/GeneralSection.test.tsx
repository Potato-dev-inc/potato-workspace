// @vitest-environment jsdom
// Settings > General: every control renders, saves the right partial patch, and destructive actions are confirmed.
import { unsearchableLabels } from '../test-utils';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeEnv, blur, buttonByText, byLabel, click, hasText, mountRows, pickOption, settle, type as typeInto, type Mounted } from '../test-utils';
import { generalRows } from './GeneralSection';

const mocks = vi.hoisted(() => ({
  install: { version: '0.9.0', isPackaged: true, platform: 'windows', uninstallAvailable: true, uninstallInstructions: 'Removes the app.', dataDir: 'C:\\data' },
  storage: { scope: 'project', project_path: 'C:\\work\\demo', storage_dir: 'C:\\work\\demo\\.potato-workspace', event_log_path: 'C:\\work\\demo\\.potato-workspace\\events.jsonl', event_count: 12, task_count: 3, lock_count: 1, exists: true },
  loop: { enabled: true, turns: 4, stalled_minutes: 20, panic_shortcut: false },
}));

vi.mock('@tauri-apps/api/path', () => ({ homeDir: vi.fn(async () => 'C:\\Users\\dev'), appConfigDir: vi.fn(async () => 'C:\\cfg'), join: vi.fn(async (...p: string[]) => p.join('\\')) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(async () => 'C:\\picked'), ask: vi.fn(async () => true) }));
vi.mock('../../../lib/settings', () => ({ resolveSettingsFilePath: vi.fn(async () => 'C:\\cfg\\settings.json') }));
vi.mock('../../../lib/tauri', () => ({
  tauri: {
    lastRunStatus: vi.fn(async () => null),
    perfSummary: vi.fn(async () => null),
    projectBudgetLimits: vi.fn(async () => null),
    projectBudgetSet: vi.fn(async (_project: string, limits: unknown) => limits),
    getAppInstallInfo: vi.fn(async () => mocks.install),
    getCoordinationStorageInfo: vi.fn(async () => mocks.storage),
    launchUninstall: vi.fn(async () => undefined),
    autostartGet: vi.fn(async () => false),
    autostartSet: vi.fn(async (enabled: boolean) => enabled),
  },
}));
vi.mock('../../../lib/loop-guard', () => ({
  tauriLoopApi: {
    settingsGet: vi.fn(async () => ({ ...mocks.loop })),
    settingsSet: vi.fn(async (next: unknown) => next),
  },
}));
vi.mock('../../../lib/cockpit-api', () => ({
  cockpitApi: {
    modeSwitchPreview: vi.fn(async () => undefined),
  },
}));
vi.mock('../../../lib/memory-api', () => ({
  memoryApi: { globalEnabled: vi.fn(async () => true), setGlobalEnabled: vi.fn(async () => undefined) },
}));

vi.mock('../../../lib/live-room', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../lib/live-room')>();
  return {
    ...orig,
    liveRoomApi: {
      ...orig.liveRoomApi,
      configGet: vi.fn(async () => ({ relay: '', minutes: 60, maxViewers: 10 })),
      configSet: vi.fn(async () => undefined),
    },
  };
});

import { accountApi, type AccountView } from '../../../lib/account';
import { LS_NAME_FILLED } from '../../../lib/discordName';
import { liveRoomApi } from '../../../lib/live-room';
import { tauri } from '../../../lib/tauri';
import { tauriLoopApi } from '../../../lib/loop-guard';
import { memoryApi } from '../../../lib/memory-api';

let m: Mounted;

async function mount(overrides: Parameters<typeof mountRows>[1] = {}) {
  m = await mountRows(generalRows, overrides);
  await settle(5);
  return m;
}

beforeEach(() => vi.clearAllMocks());
afterEach(async () => {
  await m?.unmount();
  vi.useRealTimers();
});

const switchFor = (label: string) => m.host.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${label}"]`);

describe('General: every control renders', () => {
  it('shows every live control of the old General, Appearance, Sessions, Storage and Advanced tabs that belongs here', async () => {
    await mount();
    for (const label of [
      'Default project folder',
      'Theme',
      'Mode switch animation',
      'Discord alerts',
      'Ask before closing a working agent',
      'Warn when an agent seems stuck',
      'Stuck warning sensitivity',
      'Quiet for too long',
      'Global shortcut: stop all agents',
      'Check packages before installs',
      'Tell me what happened while I was away',
      'Checkpoints',
      'Shared project memory',
      'Task and activity data',
      'Tasks',
      'File locks',
      'Event log',
      'Version',
      'Settings file',
      'Uninstall Potato Workspace',
    ]) {
      expect(hasText(m.host, label), `missing: ${label}`).toBe(true);
    }
    expect(buttonByText(m.host, 'Browse')).toBeTruthy();
    expect(buttonByText(m.host, 'Refresh')).toBeTruthy();
    expect(buttonByText(m.host, 'Check for updates')).toBeTruthy();
    expect(buttonByText(m.host, 'Export…')).toBeTruthy();
    expect(buttonByText(m.host, 'Uninstall…')).toBeTruthy();
  });

  it('has no Save button and no planned/placeholder controls', async () => {
    await mount();
    expect(buttonByText(m.host, 'Save changes')).toBeUndefined();
    expect(hasText(m.host, 'Planned')).toBe(false);
    expect(hasText(m.host, 'Not implemented')).toBe(false);
  });

  it('puts the destructive row in its own last list', async () => {
    await mount();
    const lists = [...m.host.querySelectorAll('section.st-group')];
    const last = lists[lists.length - 1];
    expect(last.getAttribute('data-danger')).toBe('true');
    expect(last.textContent).toContain('Uninstall Potato Workspace');
    expect(lists.slice(0, -1).some((s) => s.textContent?.includes('Uninstall Potato Workspace'))).toBe(false);
  });
});

/** One picture choice (a radio) of a group such as Theme. */
const radio = (group: string, choice: string): HTMLElement => m.host.querySelector<HTMLElement>(`[role="radiogroup"][aria-label="${group}"] [role="radio"][aria-label="${choice}"]`)!;

describe('General: each control saves a partial patch', () => {
  it('Theme saves only {theme}', async () => {
    await mount();
    await click(radio('Theme', 'Light'));
    expect(m.env.patches).toEqual([{ theme: 'light' }]);
  });

  it('Mode switch animation defaults to Domino and saves only {mode_switch_animation}', async () => {
    await mount();
    const select = byLabel<HTMLSelectElement>(m.host, 'Mode switch animation')!;
    expect(select.value).toBe('domino');
    expect([...select.options].map((o) => o.textContent)).toEqual(['Domino', 'Ink', 'Off']);
    await pickOption(select, 'ink');
    await pickOption(select, 'off');
    await pickOption(select, 'domino');
    expect(m.env.patches).toEqual([{ mode_switch_animation: 'ink' }, { mode_switch_animation: 'off' }, { mode_switch_animation: 'domino' }]);
  });

  it('Window layout (a window per agent) defaults to Side by side and saves only {individual_window_layout}', async () => {
    await mount();
    expect(radio('Window layout (a window per agent)', 'Side by side').getAttribute('aria-checked')).toBe('true');
    expect([...m.host.querySelectorAll('[aria-label="Window layout (a window per agent)"] [role="radio"]')].map((o) => o.textContent)).toEqual(['Side by side', 'Cascade']);
    await click(radio('Window layout (a window per agent)', 'Cascade'));
    await m.rerender();
    await click(radio('Window layout (a window per agent)', 'Side by side'));
    expect(m.env.patches).toEqual([{ individual_window_layout: 'cascade' }, { individual_window_layout: 'side_by_side' }]);
  });

  it('Window layout (a window per agent) shows the saved choice and sits right after Mode switch animation', async () => {
    await mount({ settings: { ...makeEnv().settings, individual_window_layout: 'cascade' } });
    expect(radio('Window layout (a window per agent)', 'Cascade').getAttribute('aria-checked')).toBe('true');
    const text = m.host.textContent ?? '';
    expect(text.indexOf('Mode switch animation')).toBeLessThan(text.indexOf('Window layout (a window per agent)'));
  });

  it('Mode switch animation shows the saved choice and has one Play: the picture', async () => {
    await mount({ settings: { ...makeEnv().settings, mode_switch_animation: 'ink' } });
    expect(byLabel<HTMLSelectElement>(m.host, 'Mode switch animation')!.value).toBe('ink');
    expect(buttonByText(m.host, 'Preview')).toBeUndefined();
  });

  it('Ask before closing saves only {confirm_close_running_pane}', async () => {
    await mount();
    await click(switchFor('Ask before closing a working agent'));
    expect(m.env.patches).toEqual([{ confirm_close_running_pane: false }]);
  });

  it('Keep this PC awake shows on by default and saves only {keep_awake_while_working}', async () => {
    await mount();
    expect(m.host.textContent).toContain('Your agents keep going when you lock the PC. The screen can still turn off.');
    expect(switchFor('Keep this PC awake while agents work')!.getAttribute('aria-checked')).toBe('true');
    await click(switchFor('Keep this PC awake while agents work'));
    expect(m.env.patches).toEqual([{ keep_awake_while_working: false }]);
  });

  it('Show questions that block an agent shows on by default and saves only {jump_out_cards_enabled}', async () => {
    await mount();
    expect(m.host.textContent).toContain('It never takes the keyboard.');
    expect(switchFor('Show questions that block an agent')!.getAttribute('aria-checked')).toBe('true');
    await click(switchFor('Show questions that block an agent'));
    expect(m.env.patches).toEqual([{ jump_out_cards_enabled: false }]);
  });

  it('Get early versions (beta) is off by default and saves only {early_versions_enabled}', async () => {
    await mount();
    expect(switchFor('Get early versions (beta)')!.getAttribute('aria-checked')).toBe('false');
    await click(switchFor('Get early versions (beta)'));
    expect(m.env.patches).toEqual([{ early_versions_enabled: true }]);
  });

  it('Checkpoints saves immediately (the keep-N choice is gone: 20 is kept by itself)', async () => {
    await mount();
    await click(switchFor('Checkpoints'));
    expect(m.env.patches).toEqual([{ checkpoints_enabled: false }]);
    expect(byLabel(m.host, 'Keep last N checkpoints')).toBeNull();
  });

  it('Night Shift (Labs) is off by default and saves only {night_shift_enabled}', async () => {
    await mount();
    expect(switchFor('Night Shift')!.getAttribute('aria-checked')).toBe('false');
    await click(switchFor('Night Shift'));
    expect(m.env.patches).toEqual([{ night_shift_enabled: true }]);
  });

  it('the away digest is a popup of Off, 5, 15 and 30 minutes, and saves the pick', async () => {
    await mount();
    const away = m.host.querySelector<HTMLSelectElement>('select[aria-label="Minutes away before I hear what happened (0 is off)"]')!;
    expect([...away.options].map((o) => o.value)).toEqual(['0', '5', '15', '30']);
    await pickOption(away, '15');
    expect(m.env.patches).toEqual([{ away_minutes: 15 }]);
  });

  it('Budgets are off by default (0): one preset picker, and Custom opens the two numbers', async () => {
    await mount();
    const preset = m.host.querySelector<HTMLSelectElement>('select[aria-label="How much an agent may use"]')!;
    expect(preset.value).toBe('none');
    expect(byLabel(m.host, 'Turns an agent may use (0 is no limit)')).toBeNull();
    await pickOption(preset, 'light');
    expect(m.env.patches).toEqual([{ budget_default_turns: 50, budget_default_minutes: 30 }]);
    await pickOption(preset, 'custom');
    const turns = byLabel<HTMLInputElement>(m.host, 'Turns an agent may use (0 is no limit)')!;
    const time = byLabel<HTMLInputElement>(m.host, 'Time an agent may use (0 is no limit)')!;
    await typeInto(turns, '20');
    await blur(turns);
    await typeInto(time, '99999');
    await blur(time);
    expect(m.env.patches.at(-1)).toMatchObject({ budget_default_minutes: 10080 });
    expect(hasText(m.host, 'How much an agent may use')).toBe(true);
  });

  it('Default project folder saves after a pause through onProjectPathChange, not as a whole snapshot', async () => {
    vi.useFakeTimers();
    const onProjectPathChange = vi.fn(async () => undefined);
    await mount({ onProjectPathChange });
    const field = byLabel<HTMLInputElement>(m.host, 'Default project folder')!;
    await typeInto(field, 'C:\\work\\other');
    expect(onProjectPathChange).not.toHaveBeenCalled();
    await act(async () => void (await vi.advanceTimersByTimeAsync(700)));
    expect(onProjectPathChange).toHaveBeenCalledExactlyOnceWith('C:\\work\\other');
    expect(m.env.markSaved).toHaveBeenCalled();
  });

  it('Browse saves the picked folder', async () => {
    const onProjectPathChange = vi.fn(async () => undefined);
    await mount({ onProjectPathChange });
    await click(buttonByText(m.host, 'Browse'));
    await settle();
    expect(onProjectPathChange).toHaveBeenCalledExactlyOnceWith('C:\\picked');
  });

  it('a failed folder save shows an error on the row', async () => {
    vi.useFakeTimers();
    const onProjectPathChange = vi.fn(async () => {
      throw new Error('not a folder');
    });
    await mount({ onProjectPathChange });
    const field = byLabel<HTMLInputElement>(m.host, 'Default project folder')!;
    await typeInto(field, 'nope');
    await blur(field);
    await settle();
    expect(m.env.setError).toHaveBeenCalledWith('Not saved: not a folder');
  });

  it('Loop guard and shared memory save through their own commands and tick the row', async () => {
    await mount();
    await click(switchFor('Global shortcut: stop all agents'));
    await settle();
    expect(tauriLoopApi.settingsSet).toHaveBeenCalledWith({ ...mocks.loop, panic_shortcut: true });
    await click(switchFor('Shared project memory'));
    await settle();
    expect(memoryApi.setGlobalEnabled).toHaveBeenCalledWith(false);
    expect(m.env.markSaved).toHaveBeenCalledTimes(2);
    expect(m.env.patches).toEqual([]); // none of these touch settings.json
  });
});

describe('General: Live Room', () => {
  it('has no Live Room settings any more: the defaults are saved from the Go live sheet', async () => {
    await mount();
    expect(m.host.querySelector('[data-row="live-room"]')).toBeNull();
    expect(hasText(m.host, 'Relay address')).toBe(false);
    expect(liveRoomApi.configSet).not.toHaveBeenCalled();
  });
});

describe('General: updates, export, uninstall', () => {
  it('Export builds a file with the keys redacted', async () => {
    const created: Blob[] = [];
    URL.createObjectURL = vi.fn((b: Blob) => (created.push(b), 'blob:x'));
    URL.revokeObjectURL = vi.fn();
    await mount({ settings: { ...(await import('../test-utils')).BASE_SETTINGS, anthropic_api_key: 'sk-secret' } });
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    await click(buttonByText(m.host, 'Export…'));
    anchorClick.mockRestore();
    expect(created).toHaveLength(1);
    const text = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(created[0]);
    });
    expect(text).toContain('"anthropic_api_key": "***"');
    expect(text).not.toContain('sk-secret');
  });

  it('Uninstall asks first; Cancel does nothing, confirm launches the uninstaller', async () => {
    await mount();
    m.env.confirm.mockResolvedValueOnce(false);
    await click(buttonByText(m.host, 'Uninstall…'));
    await settle();
    expect(m.env.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Uninstall Potato Workspace?', confirmLabel: 'Uninstall' }));
    expect(tauri.launchUninstall).not.toHaveBeenCalled();
    await click(buttonByText(m.host, 'Uninstall…'));
    await settle();
    expect(tauri.launchUninstall).toHaveBeenCalledTimes(1);
  });

  it('Uninstall is disabled with a plain reason in a dev build', async () => {
    mocks.install.uninstallAvailable = false;
    await mount();
    expect(buttonByText(m.host, 'Uninstall…')!.disabled).toBe(true);
    expect(hasText(m.host, 'Only available in an installed build')).toBe(true);
    mocks.install.uninstallAvailable = true;
  });
});

describe('General: search covers what the section shows', () => {
  it('every word of every label a row shows finds that row', async () => {
    await mount();
    expect(unsearchableLabels(m.host, generalRows)).toEqual([]);
  });
});

describe('General: Your name', () => {
  const field = () => byLabel<HTMLInputElement>(m.host, 'Your name')!;

  it('is empty by default: the greeting then has no name', async () => {
    await mount();
    expect(hasText(m.host, 'Your name')).toBe(true);
    expect(field().value).toBe('');
  });

  it('saves the name as typed (trimmed) when the field loses focus, and clears it with an empty field', async () => {
    await mount();
    await typeInto(field(), '  Sam  ');
    await blur(field());
    await settle();
    expect(m.env.patches).toContainEqual({ display_name: 'Sam' });
    await m.rerender();
    await typeInto(field(), '   ');
    await blur(field());
    await settle();
    expect(m.env.patches).toContainEqual({ display_name: null });
  });
});

describe('General: Your name from the Discord login', () => {
  const view = (provider: string, name: string, signedIn = true): AccountView => ({
    configured: true,
    signed_in: signedIn,
    waiting: false,
    message: null,
    account: signedIn ? { id: 'acc-1', display_name: name, provider } : null,
    device_id: null,
  });
  const asAccount = (v: AccountView) => {
    vi.spyOn(accountApi, 'state').mockResolvedValue(v);
    vi.spyOn(accountApi, 'onChanged').mockResolvedValue(() => undefined);
  };
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.removeItem(LS_NAME_FILLED);
  });

  it('fills an empty name with the Discord name, once', async () => {
    asAccount(view('discord', '  Sam   Potato '));
    await mount();
    await settle(4);
    expect(m.env.patches).toEqual([{ display_name: 'Sam Potato' }]);
    // The name is now theirs: cleared and reopened, it stays empty.
    await m.rerender();
    await settle(4);
    expect(m.env.patches).toHaveLength(1);
  });

  it('does not touch a name the person already has', async () => {
    asAccount(view('discord', 'Sam'));
    await mount({ settings: { ...makeEnv().settings, display_name: 'Mika' } });
    await settle(4);
    expect(m.env.patches).toEqual([]);
  });

  it('ignores other sign-ins and signed-out accounts', async () => {
    asAccount(view('google', 'Sam'));
    await mount();
    await settle(4);
    expect(m.env.patches).toEqual([]);
    asAccount(view('discord', 'Sam', false));
    await m.rerender();
    await settle(4);
    expect(m.env.patches).toEqual([]);
  });
});

describe('General: the X at the top right', () => {
  it('Keep running in the tray is off by default and saves only {close_to_tray}', async () => {
    await mount();
    const sw = switchFor('Keep running in the tray when I close the window')!;
    expect(sw.getAttribute('aria-checked')).toBe('false');
    await click(sw);
    expect(m.env.patches).toEqual([{ close_to_tray: true }]);
  });
});
