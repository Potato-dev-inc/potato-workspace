// @vitest-environment jsdom
// Settings > General > Save a diagnostic file: preview first, leave files out, save where the dialog says.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buttonByText, byLabel, click, mountRows, settle, type Mounted } from '../test-utils';

const mocks = vi.hoisted(() => ({
  preview: {
    totalBytes: 3000,
    files: [
      { path: 'README.txt', label: 'A short note on what this file is', bytes: 800 },
      { path: 'settings.json', label: 'Your settings, with keys and tokens removed', bytes: 1200 },
      { path: 'recordings/op-1.cast', label: 'Recording of a run that failed, 2 hours ago', bytes: 1000 },
    ],
  },
  target: 'C:\out\diag.zip' as string | null,
  lastRun: { closedUnexpectedly: false, crashedAtMs: null as number | null },
  perf: null as unknown,
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn(async () => mocks.target) }));
vi.mock('../../../lib/tauri', () => ({
  tauri: {
    diagnosticPreview: vi.fn(async () => mocks.preview),
    diagnosticShow: vi.fn(async (path: string) => `contents of ${path}`),
    lastRunStatus: vi.fn(async () => mocks.lastRun),
    perfSummary: vi.fn(async () => mocks.perf),
    diagnosticSave: vi.fn(async (path: string) => ({ path, files: 3, bytes: 2048 })),
  },
}));

import { tauri } from '../../../lib/tauri';
import { generalRows } from '../sections/GeneralSection';
import { DIAGNOSTIC_REFRESH_MS } from './DiagnosticFile';
import { act } from 'react';

const row = generalRows.filter((r) => r.id === 'diagnostic-file');
let m: Mounted;

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.target = 'C:\out\diag.zip';
  m = await mountRows(row);
});
afterEach(async () => {
  await m.unmount();
});

describe('Save a diagnostic file', () => {
  it('shows nothing about the contents until Review is pressed, and writes nothing', async () => {
    expect(m.host.textContent).toContain('Save a diagnostic file');
    expect(m.host.textContent).toContain('Nothing is sent anywhere');
    expect(m.host.querySelector('.st-diag-list')).toBeNull();
    expect(tauri.diagnosticSave).not.toHaveBeenCalled();
  });

  it('lists every file in plain words with its size before saving', async () => {
    await click(buttonByText(m.host, 'Review…'));
    const items = [...m.host.querySelectorAll('.st-diag-item')].map((i) => i.textContent);
    expect(items).toHaveLength(3);
    expect(items[1]).toContain('Your settings, with keys and tokens removed');
    expect(items[1]).toContain('1 KB');
    expect(m.host.textContent).not.toContain('recordings/op-1.cast');
  });

  it('can show one file before it is saved', async () => {
    await click(buttonByText(m.host, 'Review…'));
    await click(m.host.querySelectorAll('.st-diag-item button')[1]);
    expect(m.host.querySelector('.st-diag-text')?.textContent).toBe('contents of settings.json');
  });

  it('saves to the chosen file and leaves out what was unticked', async () => {
    await click(buttonByText(m.host, 'Review…'));
    await click(byLabel(m.host, 'Recording of a run that failed, 2 hours ago'));
    await click(buttonByText(m.host, 'Save…'));
    await settle();
    expect(tauri.diagnosticSave).toHaveBeenCalledWith('C:\out\diag.zip', ['recordings/op-1.cast']);
    expect(m.host.textContent).toContain('Saved to C:\out\diag.zip');
    expect(m.host.querySelector('.st-diag-list')).toBeNull();
  });

  it('does nothing when the save dialog is cancelled', async () => {
    mocks.target = null;
    await click(buttonByText(m.host, 'Review…'));
    await click(buttonByText(m.host, 'Save…'));
    await settle();
    expect(tauri.diagnosticSave).not.toHaveBeenCalled();
    expect(m.host.querySelector('.st-diag-list')).not.toBeNull();
  });
});

describe('the open list keeps itself current', () => {
  const newFailure = { path: 'recordings/op-2.cast', label: 'Recording of a run that failed, just now', bytes: 500 };
  const after = { totalBytes: 3500, files: [...mocks.preview.files, newFailure] };

  beforeEach(() => vi.mocked(tauri.diagnosticPreview).mockReset().mockResolvedValue(mocks.preview));
  afterEach(() => vi.useRealTimers());

  it('lists a run that failed while it was open, without pressing Refresh', async () => {
    vi.useFakeTimers();
    await click(buttonByText(m.host, 'Review…'));
    expect(m.host.querySelectorAll('.st-diag-item')).toHaveLength(3);
    vi.mocked(tauri.diagnosticPreview).mockResolvedValueOnce(after);
    await act(async () => void (await vi.advanceTimersByTimeAsync(DIAGNOSTIC_REFRESH_MS + 50)));
    expect(m.host.querySelectorAll('.st-diag-item')).toHaveLength(4);
    expect(m.host.textContent).toContain('Recording of a run that failed, just now');
  });

  it('re-reads when the window is focused again, and keeps what was unticked', async () => {
    await click(buttonByText(m.host, 'Review…'));
    await click(byLabel(m.host, 'Your settings, with keys and tokens removed'));
    vi.mocked(tauri.diagnosticPreview).mockResolvedValueOnce(after);
    await act(async () => void window.dispatchEvent(new Event('focus')));
    await settle();
    expect(m.host.querySelectorAll('.st-diag-item')).toHaveLength(4);
    expect((byLabel(m.host, 'Your settings, with keys and tokens removed') as HTMLInputElement).checked).toBe(false);
    expect((byLabel(m.host, 'Recording of a run that failed, just now') as HTMLInputElement).checked).toBe(true);
  });

  it('does not read at all while the list is closed', async () => {
    vi.useFakeTimers();
    await act(async () => void (await vi.advanceTimersByTimeAsync(DIAGNOSTIC_REFRESH_MS * 3)));
    expect(tauri.diagnosticPreview).not.toHaveBeenCalled();
  });
});

describe('Speed on this PC and the closed-unexpectedly line', () => {
  const stat = (count: number, medianMs: number | null, lastMs: number | null) => ({ count, medianMs, lastMs });
  const none = stat(0, null, null);
  const base = { firstReply: none, setupCheck: none, warmHits: 0, warmMisses: 0, startupSteps: [], startupTotalMs: null };

  afterEach(() => {
    mocks.lastRun = { closedUnexpectedly: false, crashedAtMs: null };
    mocks.perf = null;
  });

  async function remount() {
    await m.unmount();
    m = await mountRows(row);
    await settle();
  }

  it('is part of the screen: shows typical and latest times in plain words', async () => {
    mocks.perf = { ...base, appStart: stat(3, 1500, 1400), chatWarm: stat(2, 400, 350), chatCold: stat(1, 2100, 2100), handshake: none };
    await remount();
    expect(m.host.textContent).toContain('Speed on this PC');
    const row = (id: string) => [...m.host.querySelectorAll('[data-speed-row]')].find((r) => r.getAttribute('data-speed-row') === id)!;
    expect(row('chatWarm').textContent).toContain('Starting a chat that was ready ahead of time');
    expect([...row('appStart').querySelectorAll('td')].map((c) => c.textContent)).toEqual(['1.5 s', '1.4 s', '3']);
    expect(row('chatWarm').querySelector('td')!.textContent).toBe('400 ms');
    expect(m.host.textContent).not.toContain('Waiting for the agent to say hello');
    expect(m.host.querySelectorAll('[data-testid="speed-slow"]').length).toBe(0);
  });

  it('says so when nothing has been measured yet', async () => {
    mocks.perf = { ...base, appStart: none, chatWarm: none, chatCold: none, handshake: none };
    await remount();
    expect(m.host.textContent).toContain('Nothing measured yet');
  });

  it('marks the slow ones, shows the app start step by step, and the share of ready-made chat starts', async () => {
    mocks.perf = {
      ...base,
      appStart: none,
      chatWarm: stat(2, 400, 350),
      chatCold: stat(4, 9000, 8000),
      handshake: none,
      firstReply: stat(5, 2500, 3000),
      setupCheck: stat(2, 600, 600),
      warmHits: 1,
      warmMisses: 5,
      startupSteps: [{ name: 'bridge', stepMs: 2200 }, { name: 'pty_cleanup', stepMs: 3 }],
      startupTotalMs: 3100,
    };
    await remount();
    const slow = [...m.host.querySelectorAll('[data-speed-row][data-slow="true"]')].map((r) => r.getAttribute('data-speed-row'));
    expect(slow).toEqual(['step:bridge', 'chatCold', 'warm']);
    expect(m.host.textContent).toContain('App start: bridge');
    expect(m.host.textContent).not.toContain('pty cleanup');
    expect(m.host.textContent).toContain('First sign of an answer');
    expect(m.host.textContent).toContain('Checking my setup');
    expect(m.host.textContent).toContain('1 of 6');
  });

  it('Copy for support puts the numbers on the clipboard as plain text, with the slow marks', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    mocks.perf = { ...base, appStart: none, chatWarm: none, chatCold: stat(4, 9000, 8000), handshake: none };
    await remount();
    const copy = [...m.host.querySelectorAll('button')].find((b) => b.textContent === 'Copy for support')!;
    await act(async () => copy.click());
    await settle();
    expect(writeText).toHaveBeenCalledTimes(1);
    const text = (writeText.mock.calls[0] as unknown as [string])[0];
    expect(text).toContain('Speed report');
    expect(text).toContain('Starting a chat from scratch: 9.0 s (last 8.0 s), seen 4 [Slow]');
    expect(m.host.textContent).toContain('Copied');
  });

  it('shows no closed-unexpectedly line after a normal run', async () => {
    await remount();
    expect(m.host.textContent).not.toContain('closed unexpectedly');
  });

  it('after a crash, offers to save a diagnostic file, and goes away once saved', async () => {
    mocks.lastRun = { closedUnexpectedly: true, crashedAtMs: 123 };
    await remount();
    expect(m.host.textContent).toContain('Potato Workspace closed unexpectedly last time');
    const buttons = [...m.host.querySelectorAll('button')].filter((b) => b.textContent === 'Save a diagnostic file');
    expect(buttons).toHaveLength(1);
    await click(buttons[0]);
    await settle();
    expect(tauri.diagnosticSave).toHaveBeenCalledWith('C:\out\diag.zip', []);
    expect(m.host.textContent).not.toContain('closed unexpectedly');
  });
});
