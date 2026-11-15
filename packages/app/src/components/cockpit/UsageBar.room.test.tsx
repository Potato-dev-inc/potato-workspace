// @vitest-environment jsdom
// Screen level: "Room left" in the Usage card (opened from the bar at the bottom of the cockpit): one thin meter per sign-in
// on this PC, on a paired PC (with its last known number when it is offline) and lent to this PC. Numbers and labels only.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevicesFake, MAC_MINI, WORK_LAPTOP } from '../../dev/devices-fixtures';
import type { UsageApi, UsageRow, UsageSnapshot } from '../../lib/usage';

vi.mock('../../lib/settings', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/settings')>();
  return { ...real, loadSettings: async () => ({ ...(await real.loadSettings()), show_usage_bar: true }) };
});

import { UsageBar } from './UsageBar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView = () => {};

const NOW = Date.now();
const mine = (over: Partial<UsageRow> = {}): UsageRow => ({
  agent_id: 'claude', label: 'Claude', account_id: null, account_label: null, state: 'ok', reason: null,
  windows: [{ name: '5-hour', used_percent: 38, minutes: 300, resets_at_ms: NOW + 3_600_000, reset_since: false }],
  plan: null, observed_at_ms: NOW, limited_until_ms: null, page: null, ...over,
});
const usage = (rows: UsageRow[]): UsageApi => ({
  snapshot: async () => ({ rows, refreshed_at_ms: NOW }) as UsageSnapshot,
  openPage: async () => {},
  onChanged: async () => () => {},
});
const roomOf = (pct: number | null, label: string | null = null) => [{ agent_id: 'claude', agent_label: 'Claude', account_label: label, percent_left: pct, resets_at_ms: NOW + 7_200_000, observed_at_ms: NOW }];

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function open(rows: UsageRow[], fake: DevicesFake) {
  await act(async () => root.render(<UsageBar api={usage(rows)} devices={fake} />));
  for (let i = 0; i < 6; i++) await act(async () => {});
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="usage-strip"]')!.click());
  for (let i = 0; i < 6; i++) await act(async () => {});
}
const lines = () => [...document.querySelectorAll('[data-testid="room-row"] .ck-room-text')].map((n) => n.textContent ?? '');

describe('Room left in the Usage card', () => {
  it('lists this PC, a paired PC and a lent sign-in, each with its own meter', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [{ ...MAC_MINI, room: roomOf(88), room_at: Math.floor(NOW / 1000) }] });
    await open([mine(), mine({ link: 'borrowed', account_id: 'lent', account_label: 'Lent account' })], fake);
    const l = lines();
    expect(l).toHaveLength(3);
    expect(l[0]).toMatch(/^Claude on this PC: 62% left, resets /);
    expect(l[1]).toBe('Claude lent to you: 62% left');
    expect(l[2]).toMatch(/^Claude on Mac mini: 88% left, resets /);
    const meters = [...document.querySelectorAll('[data-testid="room-row"] [role="meter"]')];
    expect(meters.map((m) => m.getAttribute('aria-valuenow'))).toEqual(['62', '62', '88']);
  });

  it('shows an offline PC with its last known number and its age, and "unknown" when it has no number', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [{ ...WORK_LAPTOP, room: roomOf(40), room_at: Math.floor(NOW / 1000) - 7200 }, { ...MAC_MINI, room: roomOf(null), room_at: Math.floor(NOW / 1000) }] });
    await open([mine()], fake);
    const rows = [...document.querySelectorAll<HTMLElement>('[data-testid="room-row"]')];
    const laptop = rows.find((r) => r.textContent?.includes('Work laptop'))!;
    expect(laptop.classList.contains('is-stale')).toBe(true);
    expect(laptop.textContent).toMatch(/last known 2 hours ago/);
    expect(lines()).toContain('Claude on Mac mini: unknown');
  });

  it('is not drawn when there is only this PC to look at', async () => {
    await open([mine()], new DevicesFake({ enabled: true, devices: [] }));
    expect(document.querySelector('[data-testid="room-left"]')).toBeNull();
    expect(document.querySelector('.ck-usage-pop')).not.toBeNull();
  });
});
