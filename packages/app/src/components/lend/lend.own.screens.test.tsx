// @vitest-environment jsdom
// Lend > Request usage > "My PCs" is the Devices list. Rendered through the real RequestUsage screen with the fake devices and
// lend command layers: a device that lets me borrow is a choice (no team needed); one that does not gets one plain line; the ask
// goes over the device link (`requestOwn`), never to a team member.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevicesFake, MAC_MINI, NODE_MAC, WORK_LAPTOP } from '../../dev/devices-fixtures';
import { createFakeLendApi, lendState } from '../../dev/lend-fixtures';
import type { TeamApi } from '../../lib/team';
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
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Request usage')!;
  await click(button);
  await settle(6);
  return api;
};

describe('Request usage: my other PCs are the Devices list', () => {
  it('lists the PCs that let me borrow, says plainly which ones do not, and asks over the device link without a team', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [{ ...MAC_MINI, lets_lend: true }, { ...WORK_LAPTOP, lets_lend: false }] });
    const api = await mount(fake);
    const sheet = document.querySelector<HTMLElement>('.lend-sheet')!;
    const group = sheet.querySelector('optgroup')!;
    expect(group.label).toBe('My PCs');
    expect([...group.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['Mac mini']);
    const lines = [...sheet.querySelectorAll('[data-testid="lend-turn-on"] .lend-note')].map((p) => p.textContent);
    expect(lines).toEqual(['Turn on Borrow my agent sign-ins on Work laptop.']);
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
    expect(sheet.textContent).toContain('Turn on Borrow my agent sign-ins on Mac mini.');
    const ask = [...sheet.querySelectorAll('button')].find((b) => b.textContent === 'Ask') as HTMLButtonElement;
    expect(ask.disabled).toBe(true);
  });

  it('a PC that does not let me borrow yet says why and has a button to its Devices page (not a dead form)', async () => {
    openSettingsAt.mockClear();
    const fake = new DevicesFake({ enabled: true, devices: [{ ...MAC_MINI, lets_lend: false }] });
    await mount(fake);
    const sheet = document.querySelector<HTMLElement>('.lend-sheet')!;
    const open = [...sheet.querySelectorAll('[data-testid="lend-turn-on"] button')].find((b) => b.textContent === 'Open Devices')!;
    expect(open).toBeTruthy();
    await click(open);
    expect(openSettingsAt).toHaveBeenCalledWith('devices');
    expect(document.querySelector('.lend-sheet')).toBeNull();
  });

  it('with Devices off there are no device rows at all', async () => {
    const fake = new DevicesFake({ enabled: false, devices: [{ ...MAC_MINI, lets_lend: true }] });
    await mount(fake);
    const sheet = document.querySelector<HTMLElement>('.lend-sheet')!;
    expect(sheet.textContent).not.toContain('Mac mini');
  });
});
