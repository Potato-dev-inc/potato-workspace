// @vitest-environment jsdom
// Lend > Ask to borrow > "My PCs" is the Devices list. Rendered through the real RequestUsage screen with the fake devices and
// lend command layers: a device that lets me borrow is a choice (no team needed); one that does not gets one plain line; the ask
// goes over the device link (`requestOwn`), never to a team member.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevicesFake, MAC_MINI, NODE_MAC, WORK_LAPTOP } from '../../dev/devices-fixtures';
import { createFakeLendApi, lendState } from '../../dev/lend-fixtures';
import type { TeamApi } from '../../lib/team';
import { takePendingDevice } from '../../lib/openDevice';
import { click, settle } from '../settings/test-utils';
import { RequestUsage, REFUSAL_MS } from './RequestUsage';

vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
const openSettingsAt = vi.fn();
vi.mock('../../lib/openSettingsAt', () => ({ openSettingsAt: (...a: unknown[]) => openSettingsAt(...a) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView = () => {};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = '';
});

// No team at all: the member list is empty.
const noTeam = { configGet: async () => ({ members: [] }) } as unknown as TeamApi;

const mount = async (devices: DevicesFake) => {
  const api = createFakeLendApi(lendState({}));
  await act(async () => root.render(<RequestUsage api={api} team={noTeam} devices={devices} variant="settings" />));
  await settle(6);
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Ask to borrow')!;
  await click(button);
  await settle(6);
  return api;
};

describe('Ask to borrow: my other PCs are the Devices list', () => {
  it('lists every paired PC, opens on the first that can lend, and asks over the device link without a team', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [{ ...WORK_LAPTOP, lets_lend: false }, { ...MAC_MINI, lets_lend: true }] });
    const api = await mount(fake);
    const sheet = document.querySelector<HTMLElement>('.lend-sheet')!;
    const group = sheet.querySelector('optgroup')!;
    expect(group.label).toBe('My PCs');
    expect([...group.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['Work laptop', 'Mac mini']);
    expect(sheet.querySelector<HTMLSelectElement>('select[aria-label="Ask"]')!.value).toBe(`node:${MAC_MINI.node}`);
    expect(sheet.querySelector('[data-testid="lend-switch-off"]')).toBeNull();
    // An own PC has no offers list and no "did not answer" note: the agent picker is there at once.
    expect(sheet.querySelector('[data-testid="lend-no-answer"]')).toBeNull();
    expect(sheet.querySelector('select[aria-label="Agent"]')).toBeTruthy();
    const ask = [...sheet.querySelectorAll('button')].find((b) => b.textContent === 'Ask')!;
    await click(ask);
    await settle(4);
    expect(api.calls.some((c) => c.startsWith('requestOwn'))).toBe(true);
    expect(api.calls.some((c) => c.startsWith('request('))).toBe(false);
    expect(api.calls.join('\n')).toContain(NODE_MAC);
    expect(document.querySelector('.lend-sheet')!.textContent).toContain('Waiting');
  });

  it('with the only PC not letting me borrow yet, it is still listed and Ask works; the line says where the switch is', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [{ ...MAC_MINI, lets_lend: false }] });
    await mount(fake);
    const sheet = document.querySelector<HTMLElement>('.lend-sheet')!;
    expect([...sheet.querySelectorAll('optgroup option')].map((o) => o.textContent)).toEqual(['Mac mini']);
    expect(sheet.textContent).toContain('turn on “Borrow my agent sign-ins” for Mac mini in Connect › Devices');
    const ask = [...sheet.querySelectorAll('button')].find((b) => b.textContent === 'Ask') as HTMLButtonElement;
    expect(ask.disabled).toBe(false);
  });

  it('a PC that cannot be asked yet says which switch is off and opens that switch on THIS PC, on that device page', async () => {
    openSettingsAt.mockClear();
    const fake = new DevicesFake({ enabled: true, devices: [{ ...MAC_MINI, lets_lend: false }] });
    await mount(fake);
    const sheet = document.querySelector<HTMLElement>('.lend-sheet')!;
    const open = [...sheet.querySelectorAll('[data-testid="lend-switch-off"] button')].find((b) => b.textContent === 'Open the switch')!;
    expect(open).toBeTruthy();
    await click(open);
    expect(openSettingsAt).toHaveBeenCalledWith('devices');
    // The switch lives on Mac mini's page here, not on the list: the person lands on it.
    expect(takePendingDevice()).toBe(NODE_MAC);
    expect(document.querySelector('.lend-sheet')).toBeNull();
  });

  it('with Devices off there are no device rows at all', async () => {
    const fake = new DevicesFake({ enabled: false, devices: [{ ...MAC_MINI, lets_lend: true }] });
    await mount(fake);
    const sheet = document.querySelector<HTMLElement>('.lend-sheet')!;
    expect(sheet.textContent).not.toContain('Mac mini');
  });

  it.each([
    [
      'its Borrow my agent sign-ins for this PC',
      'Mac mini does not let this PC borrow yet. Turn on Borrow my agent sign-ins for this PC there: Settings > Devices.',
      'otherDevice',
      'Borrow my agent sign-ins is off on Mac mini. Turn it on there, for this PC.',
    ],
    ['its Lend an agent', 'Lending is off on this PC.', 'otherGlobal', 'Lend an agent is off on Mac mini. Turn it on there.'],
  ])('%s is off there: the ask answers with one line naming it, and no button (nothing is changed there from here)', async (_what, words, kind, line) => {
    const fake = new DevicesFake({ enabled: true, devices: [{ ...MAC_MINI, lets_lend: true }] });
    const api = createFakeLendApi(lendState({}));
    api.backend.failWith = words;
    await act(async () => root.render(<RequestUsage api={api} team={noTeam} devices={fake} variant="settings" />));
    await settle(6);
    await click([...host.querySelectorAll('button')].find((b) => b.textContent === 'Ask to borrow')!);
    await settle(6);
    const sheet = document.querySelector<HTMLElement>('.lend-sheet')!;
    await click([...sheet.querySelectorAll('button')].find((b) => b.textContent === 'Ask')!);
    await settle(4);
    const off = sheet.querySelector<HTMLElement>('[data-testid="lend-switch-off"]')!;
    expect(off.getAttribute('data-switch')).toBe(kind);
    expect(off.getAttribute('data-where')).toBe('other');
    expect(off.querySelector('.lend-note')!.textContent).toBe(line);
    // No switch button (nothing is changed there from here); only Try again.
    expect([...off.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Try again']);
    // Refused: asking again is off until another PC is picked, and the line is the reason.
    const ask = [...sheet.querySelectorAll('button')].find((b) => b.textContent === 'Ask') as HTMLButtonElement;
    expect(ask.disabled).toBe(true);
  });
  it('the stale "is off on Mac mini" line goes by itself when the switch is turned on there (no reopening), and Ask is open again', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [{ ...MAC_MINI, lets_lend: false }] });
    const api = createFakeLendApi(lendState({}));
    api.backend.failWith = 'Mac mini does not let this PC borrow yet. Turn on Borrow my agent sign-ins for this PC there: Settings > Devices.';
    await act(async () => root.render(<RequestUsage api={api} team={noTeam} devices={fake} variant="settings" />));
    await settle(6);
    await click([...host.querySelectorAll('button')].find((b) => b.textContent === 'Ask to borrow')!);
    await settle(6);
    const sheet = document.querySelector<HTMLElement>('.lend-sheet')!;
    await click([...sheet.querySelectorAll('button')].find((b) => b.textContent === 'Ask')!);
    await settle(4);
    expect(sheet.querySelector('[data-testid="lend-switch-off"][data-switch="otherDevice"]')).not.toBeNull();
    await act(async () => fake.setDevice(NODE_MAC, { lets_lend: true }));
    await settle(4);
    expect(sheet.querySelector('[data-testid="lend-switch-off"]')).toBeNull();
    expect(([...sheet.querySelectorAll('button')].find((b) => b.textContent === 'Ask') as HTMLButtonElement).disabled).toBe(false);
  });
  it('the refusal is the answer to the last ask, not live state: it goes after 10 s with no new state, and Try again asks at once', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [{ ...MAC_MINI, lets_lend: true }] });
    const api = createFakeLendApi(lendState({}));
    api.backend.failWith = 'Lending is off on this PC.';
    await act(async () => root.render(<RequestUsage api={api} team={noTeam} devices={fake} variant="settings" />));
    await settle(6);
    await click([...host.querySelectorAll('button')].find((b) => b.textContent === 'Ask to borrow')!);
    await settle(6);
    const sheet = document.querySelector<HTMLElement>('.lend-sheet')!;
    const asks = () => api.calls.filter((c) => c.startsWith('requestOwn')).length;
    await click([...sheet.querySelectorAll('button')].find((b) => b.textContent === 'Ask')!);
    await settle(4);
    expect(asks()).toBe(1);
    expect(sheet.querySelector('[data-testid="lend-switch-off"]')).not.toBeNull();
    vi.useFakeTimers();
    try {
      await click(sheet.querySelector<HTMLElement>('[data-testid="lend-switch-retry"]')!);
      await settle(4);
      expect(asks()).toBe(2);
      expect(sheet.querySelector('[data-testid="lend-switch-off"]')).not.toBeNull();
      await act(async () => void vi.advanceTimersByTime(REFUSAL_MS + 100));
    } finally {
      vi.useRealTimers();
    }
    expect(sheet.querySelector('[data-testid="lend-switch-off"]')).toBeNull();
  });
});
