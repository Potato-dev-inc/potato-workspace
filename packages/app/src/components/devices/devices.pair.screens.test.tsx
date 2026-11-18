// @vitest-environment jsdom
// The "wants to pair" sheet in its two modes, through the real DevicesPage; only the devices command layer is the fake
// (`DevicesFake`). Proves: check mode shows three number buttons and no Allow; a tapped number sends its 6 digits; code mode
// is unchanged; the Far away note shows only for a link that goes through the person's own relay.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevicesFake } from '../../dev/devices-fixtures';
import { click, settle } from '../settings/test-utils';
import { DevicesPage } from './DevicesPage';

vi.mock('../../lib/tauri', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../lib/tauri')>();
  return {
    ...orig,
    tauri: {
      ...orig.tauri,
      listPairedMobileDevices: vi.fn(async () => []),
    },
  };
});

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

const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);

const mount = async (fake: DevicesFake) => {
  await act(async () => root.render(<DevicesPage api={fake} />));
  await settle(6);
};

describe('the wants-to-pair sheet: check mode (three numbers, no Allow)', () => {
  it('shows the other PC, its key fingerprint, the help lines and three number buttons, and no Allow button', async () => {
    const fake = new DevicesFake({ enabled: true });
    await mount(fake);
    await act(async () => fake.simulateIncomingCheck('Desk-PC', '678901'));
    await settle(4);
    const sheet = q('[data-testid="pair-confirm"]')!;
    expect(sheet.textContent).toContain('Desk-PC wants to connect');
    expect(sheet.textContent).toContain('Its key looks like');
    expect(q('[data-testid="pair-fingerprint"]')!.textContent).toBe('A1B2 C3D4');
    expect(sheet.textContent).not.toContain('Check the 6 numbers match');
    expect(sheet.querySelectorAll('.dev-note:not(details .dev-note)')).toHaveLength(1);
    expect(sheet.textContent).toContain('Tap the number that is on both screens.');
    expect(q<HTMLDetailsElement>('.dev-more')!.open).toBe(false);
    expect(q('[data-testid="pair-pick-012345"]')!.textContent).toBe('012 345');
    expect(q('[data-testid="pair-pick-678901"]')!.textContent).toBe('678 901');
    expect(q('[data-testid="pair-pick-234567"]')!.textContent).toBe('234 567');
    expect(q('[data-testid="pair-allow"]')).toBeNull();
    expect(q('[data-testid="pair-no"]')).not.toBeNull();
    expect(q('[data-testid="pair-none-hint"]')?.textContent).toContain("press No");
    expect(q('.dev-code')).toBeNull();
  });

  it('tapping the number both screens show sends its 6 digits and pairs', async () => {
    const fake = new DevicesFake({ enabled: true });
    await mount(fake);
    await act(async () => fake.simulateIncomingCheck('Desk-PC', '678901'));
    await settle(4);
    await click(q('[data-testid="pair-pick-678901"]'));
    await settle(6);
    expect(fake.pickCalls).toEqual(['678901']);
    expect(q('[data-testid="pair-confirm"]')).toBeNull();
    expect(fake.view.devices.map((d) => d.name)).toContain('Desk-PC');
  });

  it('a number that is not on the other screen does not pair; No sends a refusal', async () => {
    const fake = new DevicesFake({ enabled: true });
    await mount(fake);
    await act(async () => fake.simulateIncomingCheck('Desk-PC', '678901'));
    await settle(4);
    await click(q('[data-testid="pair-pick-012345"]'));
    await settle(4);
    expect(fake.pickCalls).toEqual(['012345']);
    expect(q('[data-testid="pair-confirm"]')).toBeNull();
    expect(fake.view.devices.map((d) => d.name)).not.toContain('Desk-PC');
    await act(async () => fake.simulateIncomingCheck('Desk-PC', '678901'));
    await settle(4);
    await click(q('[data-testid="pair-no"]'));
    await settle(4);
    expect(q('[data-testid="pair-confirm"]')).toBeNull();
    expect(fake.pickCalls).toEqual(['012345']);
  });
});

describe('the wants-to-pair sheet: code mode is unchanged', () => {
  it('still shows the same code with Allow and No, and no number buttons', async () => {
    const fake = new DevicesFake({ enabled: true });
    await mount(fake);
    await act(async () => fake.simulateIncoming('Desk-PC', '4F7Q-9K2M'));
    await settle(4);
    const sheet = q('[data-testid="pair-confirm"]')!;
    expect(sheet.textContent).toContain('"Desk-PC" wants to pair. Code 4F7Q-9K2M.');
    expect(q('.dev-code')!.textContent).toBe('4F7Q-9K2M');
    expect(q('[data-testid="pair-allow"]')).not.toBeNull();
    expect(q('[data-testid="pair-pick-012345"]')).toBeNull();
    await click(q('[data-testid="pair-no"]'));
    await settle(4);
    expect(q('[data-testid="pair-confirm"]')).toBeNull();
  });
});

describe('Far away: the relay note', () => {
  const openFar = async (fake: DevicesFake) => {
    await mount(fake);
    await click(q('[data-testid="add-device"]'));
  };

  it('tells a link that does not go through a relay what that means, in one plain sentence', async () => {
    const fake = new DevicesFake({ enabled: true });
    await openFar(fake);
    await click(q('[data-testid="make-link"]'));
    await settle(4);
    expect(q('[data-testid="the-link"]')).not.toBeNull();
    expect(q('[data-testid="far-via-relay"]')).toBeNull();
    expect(q('[data-testid="far-no-relay"]')!.textContent).toContain('You have no relay yet');
  });

  it('shows the one-line note when the link goes through my relay', async () => {
    const fake = new DevicesFake({ enabled: true });
    fake.makeLink = async () => {
      fake.view = { ...fake.view, hosting: { kind: 'link', code: '', address: '', link: 'pm1link:' + 'cd34'.repeat(30), expires_at: Date.now() + 600_000, worker: true } };
      return fake.view;
    };
    await openFar(fake);
    await click(q('[data-testid="make-link"]'));
    await settle(4);
    expect(q('[data-testid="the-link"]')).not.toBeNull();
    expect(q('[data-testid="far-via-relay"]')!.textContent).toBe('The two PCs meet through your relay, so this works from any network. Nobody types an address.');
    expect(q('[data-testid="far-no-relay"]')).toBeNull();
  });
});
