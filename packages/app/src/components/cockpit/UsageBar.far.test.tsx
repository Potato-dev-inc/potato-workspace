// @vitest-environment jsdom
// Screen level: the usage bar while the open session runs on another PC. The bar shows that PC's numbers (`GET /pclink/usage`) with a small
// device tag and none of this PC's; an offline PC shows its last known numbers with their age; a PC that never answered says so; this PC's
// bar is back, unchanged, when the session is this PC's. Only the device link and this PC's usage reader are fakes.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevicesFake, MAC_MINI, NODE_MAC } from '../../dev/devices-fixtures';
import type { UsageApi, UsageRow, UsageSnapshot } from '../../lib/usage';

vi.mock('../../lib/settings', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/settings')>();
  return { ...real, loadSettings: async () => ({ ...(await real.loadSettings()), show_usage_bar: true }) };
});

import { forgetFarUsageInMemory } from '../../lib/runtime/farUsage';
import { UsageBar } from './UsageBar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView = () => {};

const NOW = Date.now();
const row = (pct: number, over: Partial<UsageRow> = {}): UsageRow => ({
  agent_id: 'claude', label: 'Claude', account_id: null, account_label: null, state: 'ok', reason: null,
  windows: [{ name: '5-hour', used_percent: pct, minutes: 300, resets_at_ms: NOW + 3_600_000, reset_since: false }],
  plan: null, observed_at_ms: NOW, limited_until_ms: null, page: null, ...over,
});
const snap = (rows: UsageRow[]): UsageSnapshot => ({ rows, refreshed_at_ms: NOW });
const here = (rows: UsageRow[]): UsageApi => ({
  snapshot: vi.fn(async () => snap(rows)),
  openPage: async () => {},
  onChanged: async () => () => {},
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
  window.localStorage.clear();
  forgetFarUsageInMemory();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  window.localStorage.clear();
});

const settle = async () => {
  for (let i = 0; i < 8; i++) await act(async () => {});
};
async function show(api: UsageApi, fake: DevicesFake, far: { node: string; name: string } | null) {
  await act(async () => root.render(<UsageBar api={api} devices={fake} far={far} />));
  await settle();
}
const strip = () => host.querySelector<HTMLElement>('[data-testid="usage-strip"]');
const chips = () => [...host.querySelectorAll('.ck-sb-chips .ck-usage-chip:not(.ck-sb-measure *)')].map((c) => c.getAttribute('data-tip') ?? '');
const FAR = { node: NODE_MAC, name: 'Mac mini' };

describe('Usage bar for a session on another PC', () => {
  it("shows the other PC's numbers with its name as a tag, and none of this PC's", async () => {
    const fake = new DevicesFake({ enabled: true, devices: [MAC_MINI] });
    fake.usageOf[NODE_MAC] = snap([row(42)]);
    const own = here([row(7)]);
    await show(own, fake, FAR);
    expect(fake.requests.some((r) => r.node === NODE_MAC && r.method === 'GET' && r.path === '/pclink/usage')).toBe(true);
    expect(host.querySelector('[data-testid="usage-far-tag"]')!.textContent).toBe('Mac mini');
    expect(strip()!.getAttribute('aria-label')).toContain('Usage on Mac mini');
    expect(host.querySelector('.ck-sb-chips .ck-usage-pct')!.textContent).toBe('42%');
    expect(host.textContent).not.toContain('7%');
    // This PC's own reader was never asked while that PC is showing.
    expect(own.snapshot).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="usage-far-stale"]')).toBeNull();
  });

  it('the card says whose limits these are, has no sign-in button and no PC meters, and feeds nothing into this PC problems', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [MAC_MINI] });
    fake.usageOf[NODE_MAC] = snap([row(0, { state: 'expired', windows: [], reason: 'Signed out' })]);
    await show(here([row(7)]), fake, FAR);
    await act(async () => strip()!.click());
    await settle();
    expect(document.querySelector('.ck-usage-pop-title')!.textContent).toBe('Usage on Mac mini');
    expect(document.querySelector('[data-testid="usage-sign-in-again"]')).toBeNull();
    expect(document.querySelector('[data-testid="room-row"]')).toBeNull();
  });

  it('lent and borrowed sign-ins of the other PC are not shown as its own numbers', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [MAC_MINI] });
    fake.usageOf[NODE_MAC] = snap([row(42), row(99, { link: 'borrowed', account_id: 'x', account_label: 'Lent' })]);
    await show(here([]), fake, FAR);
    expect(host.querySelectorAll('.ck-sb-chips .ck-usage-chip')).toHaveLength(1);
  });

  it('when the PC goes offline the last known numbers stay, marked with their age', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [MAC_MINI] });
    window.localStorage.setItem('pm.farUsage.v1', JSON.stringify({ [NODE_MAC]: { snap: snap([row(61)]), at: Date.now() - 2 * 3_600_000 } }));
    // Offline: every request to it fails.
    fake.request = async () => {
      throw new Error('That device is offline.');
    };
    await show(here([row(7)]), fake, FAR);
    expect(host.querySelector('.ck-sb-chips .ck-usage-pct')!.textContent).toBe('61%');
    expect(host.querySelector('[data-testid="usage-far-stale"]')!.textContent).toBe(' · last known 2 hours ago');
    expect(host.textContent).not.toContain('7%');
  });

  it('a PC that never answered says so in one line, not this PC numbers', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [MAC_MINI] });
    fake.request = async () => {
      throw new Error('That device is offline.');
    };
    await show(here([row(7)]), fake, FAR);
    expect(host.querySelector('[data-testid="usage-far-none"]')!.textContent).toBe('Mac mini has not shared its usage.');
    expect(host.textContent).not.toContain('7%');
  });

  it("this PC's own bar is unchanged when the session is this PC's", async () => {
    const fake = new DevicesFake({ enabled: true, devices: [MAC_MINI] });
    fake.usageOf[NODE_MAC] = snap([row(42)]);
    await show(here([row(7)]), fake, null);
    expect(host.querySelector('[data-testid="usage-far-tag"]')).toBeNull();
    expect(host.querySelector('.ck-sb-chips .ck-usage-pct')!.textContent).toBe('7%');
    expect(fake.requests.some((r) => r.path === '/pclink/usage')).toBe(false);
  });

  it('the chip says whose limit it is when hovered', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [MAC_MINI] });
    fake.usageOf[NODE_MAC] = snap([row(42)]);
    await show(here([row(7)]), fake, FAR);
    expect(host.querySelector('.ck-sb-chips .ck-usage-chip')!.getAttribute('title')).toMatch(/^Claude on Mac mini: 42% of its limit, resets in \d+ (h|m)$/);
  });

  it('chips of the two PCs never share a key (the other PC rows carry its name)', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [MAC_MINI] });
    fake.usageOf[NODE_MAC] = snap([row(42)]);
    await show(here([row(7)]), fake, FAR);
    expect(chips().length).toBeGreaterThan(0);
    expect(host.querySelector('[data-row]')!.getAttribute('data-row')).toBe(`claude:far:${NODE_MAC}:`);
  });
});
