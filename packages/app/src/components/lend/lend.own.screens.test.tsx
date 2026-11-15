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
import { RequestUsage } from './RequestUsage';

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
  it('lists the PCs that let me borrow, says plainly which ones do not, and asks over the device link without a team', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [{ ...MAC_MINI, lets_lend: true }, { ...WORK_LAPTOP, lets_lend: false }] });
    const api = await mount(fake);
    const sheet = document.querySelector<HTMLElement>('.lend-sheet')!;
    const group = sheet.querySelector('optgroup')!;
    expect(group.label).toBe('My PCs');
    expect([...group.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['Mac mini']);
    const lines = [...sheet.querySelectorAll('[data-testid="lend-switch-off"]')].map((p) => p.querySelector('.lend-note')?.textContent);
    expect(lines).toEqual(['Borrow my agent sign-ins is off on this PC for Work laptop. Borrowing needs it on.']);
    expect(sheet.querySelector('[data-testid="lend-switch-off"]')!.getAttribute('data-switch')).toBe('thisDevice');
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

  it('with no device letting me borrow, only the plain lines show and Ask stays off', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [{ ...MAC_MINI, lets_lend: false }] });
    await mount(fake);
    const sheet = document.querySelector<HTMLElement>('.lend-sheet')!;
    expect(sheet.textContent).toContain('Borrow my agent sign-ins is off on this PC for Mac mini. Borrowing needs it on.');
    const ask = [...sheet.querySelectorAll('button')].find((b) => b.textContent === 'Ask') as HTMLButtonElement;
    expect(ask.disabled).toBe(true);
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
    expect(off.querySelector('button')).toBeNull();
  });
});
