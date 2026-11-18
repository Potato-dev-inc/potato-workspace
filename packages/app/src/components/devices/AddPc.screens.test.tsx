// @vitest-environment jsdom
// Connect > My PCs > Add a PC, through the real DevicesPage (the Connect variant); only the devices command layer is a
// fake. Proves: the main surface has no address, port, code or route words; the way to add a PC is one link (Copy and a
// picture) and one paste box; the older ways are folded away; and two app windows pair by passing that one link.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DevicesFake } from '../../dev/devices-fixtures';
import { click, settle, type as typeInto } from '../settings/test-utils';
import { DevicesPage } from './DevicesPage';

vi.mock('../../lib/tauri', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../lib/tauri')>();
  return { ...orig, tauri: { ...orig.tauri, listPairedMobileDevices: vi.fn(async () => []) } };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView = () => {};

const roots: { root: Root; host: HTMLDivElement }[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) {
    await act(async () => r.root.unmount());
    r.host.remove();
  }
  document.body.innerHTML = '';
});

/** One app window: its own host element and its own devices fake. */
async function appWindow(fake: DevicesFake) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push({ root, host });
  await act(async () => root.render(<DevicesPage api={fake} variant="connect" />));
  await settle(6);
  return host;
}

const q = <T extends Element = HTMLElement>(host: ParentNode, sel: string) => host.querySelector<T>(sel);
/** Words a person could not be expected to know. None may be on the main surface of the sheet or the page. */
const JARGON = /pm1:|pm2:|https?:\/\/|workers\.dev|:\d{4,5}\b|tunnel|trycloudflare|port\b/i;

describe('My PCs > Add a PC', () => {
  it('the page itself has one Add a PC button, no code button and no route block', async () => {
    const host = await appWindow(new DevicesFake({ enabled: true }));
    expect(q(host, '[data-testid="add-device"]')!.textContent).toBe('Add a PC');
    expect(q(host, '[data-testid="show-code"]')).toBeNull();
    expect(q(host, '[data-testid="route-setting"]')).toBeNull();
    expect(host.textContent).not.toContain('How far-away devices connect');
    expect(JARGON.test(host.textContent ?? '')).toBe(false);
  });

  it('the sheet opens on the link way: one button, one paste box, no address or code field, older ways folded', async () => {
    const host = await appWindow(new DevicesFake({ enabled: true }));
    await click(q(host, '[data-testid="add-device"]'));
    const sheet = q(document, '[data-testid="add-device-sheet"]')!;
    expect(sheet.querySelector('h2')!.textContent).toBe('Add a PC');
    expect(q(sheet, '[data-testid="make-link"]')!.textContent).toBe('Make a link');
    expect(q(sheet, '[data-testid="paste-link"]')).not.toBeNull();
    expect(q(sheet, '[data-testid="join-address"]')).toBeNull();
    expect(q(sheet, '[data-testid="join-code"]')).toBeNull();
    expect(q<HTMLDetailsElement>(sheet, '[data-testid="add-more"]')!.open).toBe(false);
    const visible = (sheet.textContent ?? '').replace(q(sheet, '[data-testid="add-more"]')!.textContent ?? '', '');
    expect(JARGON.test(visible)).toBe(false);
  });

  it('a made link is one Copy button and a picture; the text is folded; no address or port shows; closing withdraws it', async () => {
    const fake = new DevicesFake({ enabled: true });
    fake.makeLink = async () => {
      fake.view = { ...fake.view, hosting: { kind: 'link', code: '', address: '', link: 'pm1link:' + 'cd34'.repeat(30), expires_at: Date.now() + 600_000, worker: true } };
      return fake.view;
    };
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const host = await appWindow(fake);
    await click(q(host, '[data-testid="add-device"]'));
    await click(q(document, '[data-testid="make-link"]'));
    await settle(8);
    const box = q(document, '[data-testid="link-box"]')!;
    expect(q(box, '[data-testid="link-qr"]')!.getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
    expect(q<HTMLDetailsElement>(box, '.dev-link-text')!.open).toBe(false);
    await click(q(box, '[data-testid="copy-link"]'));
    expect(writeText).toHaveBeenCalledWith('pm1link:' + 'cd34'.repeat(30));
    expect(q(box, '[data-testid="copy-link"]')!.textContent).toBe('Copied');
    expect(q(document, '[data-testid="far-via-relay"]')!.textContent).toContain('meet through your relay');
    const sheet = q(document, '[data-testid="add-device-sheet"]')!;
    // Everything the person can see (not the folded text) is free of addresses and codes.
    const seen = (sheet.textContent ?? '').replace(q(sheet, '.dev-link-text')!.textContent ?? '', '');
    expect(JARGON.test(seen)).toBe(false);
    await click(document.querySelector('.dev-actions .dev-btn'));
    await settle(3);
    expect(fake.view.hosting).toBeNull();
  });

  it('the older ways are one step away: same network (code and address), and this PC can show the code from there', async () => {
    const host = await appWindow(new DevicesFake({ enabled: true }));
    await click(q(host, '[data-testid="add-device"]'));
    await click(q(document, '[data-testid="add-more"] summary'));
    expect(q<HTMLDetailsElement>(document, '[data-testid="add-more"]')!.open).toBe(true);
    await click(q(document, '[data-testid="add-tab-code"]'));
    expect(q(document, '[data-testid="join-address"]')).not.toBeNull();
    // The fold closes again even while a non-link way is chosen.
    await click(q(document, '[data-testid="add-more"] summary'));
    expect(q<HTMLDetailsElement>(document, '[data-testid="add-more"]')!.open).toBe(false);
    await click(q(document, '[data-testid="add-show-code"]'));
    await settle(4);
    expect(q(document, '[data-testid="add-device-sheet"]')).toBeNull();
    expect(q(document, '[data-testid="show-code-sheet"]')).not.toBeNull();
    expect(q(document, '[data-testid="the-code"]')).not.toBeNull();
  });
});

describe('two app windows, one link', () => {
  it('PC 1 makes the link, PC 2 pastes the same text, both confirm, and each lists the other', async () => {
    const pc1 = new DevicesFake({ enabled: true });
    const pc2 = new DevicesFake({ enabled: true });
    const link = 'pm1link:' + 'ee55'.repeat(30);
    pc1.makeLink = async () => {
      pc1.view = { ...pc1.view, hosting: { kind: 'link', code: '', address: '', link, expires_at: Date.now() + 600_000, worker: true } };
      return pc1.view;
    };
    const w1 = await appWindow(pc1);
    const w2 = await appWindow(pc2);
    // PC 1: Add a PC > Make a link.
    await click(q(w1, '[data-testid="add-device"]'));
    await click(q(document, '[data-testid="make-link"]'));
    await settle(6);
    const shown = q<HTMLTextAreaElement>(document, '[data-testid="the-link"]')!.value;
    expect(shown).toBe(link);
    // PC 2: Add a PC > paste.
    const first = q(document, '[data-testid="add-device-sheet"]')!;
    await click(q(w2, '[data-testid="add-device"]'));
    const second = [...document.querySelectorAll('[data-testid="add-device-sheet"]')].find((s) => s !== first)!;
    await typeInto(q<HTMLInputElement>(second, '[data-testid="paste-link"]')!, shown);
    await click(q(second, '[data-testid="join-link-go"]'));
    await settle(6);
    expect(pc2.joinLinks).toEqual([link]);
    // Both screens ask once. PC 1 sees PC 2's name and picks the number; PC 2 allows.
    act(() => pc1.simulateIncomingCheck('Laptop', '012345'));
    await settle(4);
    expect(q(w1, '[data-testid="pair-confirm"]')!.textContent).toContain('Laptop wants to connect');
    await click(q(w1, '[data-testid="pair-pick-012345"]'));
    await click(q(w2, '[data-testid="pair-allow"]'));
    await settle(10);
    expect(pc1.view.devices.map((d) => d.name)).toEqual(['Laptop']);
    expect(pc2.view.devices).toHaveLength(1);
    expect(q(w1, '.dev-list')!.textContent).toContain('Laptop');
    expect(q(w2, '.dev-list')!.textContent).toContain('Studio PC');
  });
});
