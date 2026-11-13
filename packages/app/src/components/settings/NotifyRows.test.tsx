// @vitest-environment jsdom
// Settings rows for notifications: Quiet hours (Look and feel) and an agent's bell. Both save to the PC, not the page.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SECTIONS } from './catalog';
import { resetNotifyStoreForTest } from '../../lib/notify-store';
import { AgentNotifyRows, fromClock, toClock } from './NotifyRows';
import { byLabel, click, mountRows, pickOption, settle, type, type Mounted } from './test-utils';

const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
  if (cmd === 'notify_prefs_get') return { bells: {}, quiet: { enabled: false, start: 1320, end: 420 }, snoozes: {}, imported: true };
  void args;
  return null;
});
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => (invoke as (...x: unknown[]) => unknown)(...a) }));

let m: Mounted;
beforeEach(() => {
  (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
  resetNotifyStoreForTest();
  invoke.mockClear();
});
afterEach(async () => {
  await m?.unmount();
  delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
});

describe('Quiet hours row (Look and feel)', () => {
  const row = SECTIONS.find((s) => s.id === 'look')!.rows.find((r) => r.id === 'quiet-hours')!;

  it('is on the Look and feel page, in "While agents work"', () => {
    expect(row.group).toBe('While agents work');
  });

  it('the switch turns it on, shows start and end, and every change is saved on the PC', async () => {
    m = await mountRows([row]);
    expect(byLabel(m.host, 'Quiet hours start')).toBeNull();
    await click(byLabel(m.host, 'Quiet hours'));
    expect(invoke).toHaveBeenCalledWith('notify_quiet_set', { quiet: { enabled: true, start: 1320, end: 420 } });
    expect(m.env.markSaved).toHaveBeenCalled();
    const start = byLabel<HTMLInputElement>(m.host, 'Quiet hours start')!;
    expect(start.value).toBe('22:00');
    await type(start, '23:30');
    expect(invoke).toHaveBeenLastCalledWith('notify_quiet_set', { quiet: { enabled: true, start: 23 * 60 + 30, end: 420 } });
  });

  it('clock text converts both ways and ignores nonsense', () => {
    expect(toClock(7 * 60 + 5)).toBe('07:05');
    expect(fromClock('23:59', 0)).toBe(1439);
    expect(fromClock('24:00', 5)).toBe(5);
    expect(fromClock('', 5)).toBe(5);
  });
});

describe('Notifications row on an agent page', () => {
  it('shows the four levels and saves the pick for that agent only', async () => {
    m = await mountRows([{ id: 'x', label: 'x', group: 'g', render: () => <AgentNotifyRows agentId="codex" label="Codex" /> }]);
    await settle();
    const bell = byLabel<HTMLSelectElement>(m.host, 'Notifications for Codex')!;
    expect(Array.from(bell.options).map((o) => o.textContent)).toEqual(['Everything', 'Only when it needs me', 'Only when it is finished', 'Silent']);
    expect(bell.value).toBe('everything');
    await pickOption(bell, 'silent');
    expect(invoke).toHaveBeenCalledWith('notify_bell_set', { key: 'codex', level: 'silent' });
    expect(byLabel<HTMLSelectElement>(m.host, 'Notifications for Codex')!.value).toBe('silent');
  });

  it('the helpers of the agent have their own bell, starting at only when it needs me', async () => {
    m = await mountRows([{ id: 'x', label: 'x', group: 'g', render: () => <AgentNotifyRows agentId="codex" label="Codex" /> }]);
    const helpers = byLabel<HTMLSelectElement>(m.host, 'Notifications for helpers of Codex')!;
    expect(helpers.value).toBe('needs');
    await pickOption(helpers, 'finished');
    expect(invoke).toHaveBeenCalledWith('notify_bell_set', { key: 'helper:codex', level: 'finished' });
  });
});
