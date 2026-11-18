// @vitest-environment jsdom
// Settings > Devices as a whole screen, through the real components; only the devices command layer is the fake
// (`DevicesFake`). Proves: Add a device -> a code -> both people confirm -> the next step with the button to its rights
// choice -> the device page with every switch off; Show a code; the route setting; the device chip; Remove; and with the
// Labs switch off nothing renders.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DevicesFake, MAC_MINI, NODE_LAPTOP, NODE_MAC, WORK_LAPTOP } from '../../dev/devices-fixtures';
import { openDeviceAt } from '../../lib/openDevice';
import { SECTIONS } from '../settings/catalog';
import { visibleSections } from '../settings/model';
import { click, settle, type as typeInto } from '../settings/test-utils';
import { DevicesPage } from './DevicesPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

async function mount(fake: DevicesFake) {
  await act(async () => root.render(<DevicesPage api={fake} />));
  await settle(6);
}

describe('Settings > Devices', () => {
  it('with no other PC: one block, one plain sentence and a button that opens Add a device', async () => {
    const fake = new DevicesFake({ enabled: true });
    await mount(fake);
    const block = q('[data-testid="devices-empty"]')!;
    expect(block.querySelector('.ck-empty-title')!.textContent).toBe('No other PC yet');
    expect(block.querySelector('.ck-empty-line')!.textContent).toContain('Add another PC to run an agent or a terminal there');
    const add = [...block.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Add another PC')!;
    expect(add.className).toContain('ck-btn--primary');
    await click(add);
    expect(q('[data-testid="add-device-sheet"]')).not.toBeNull();
  });

  it('walks Add a device -> code -> both confirm -> the device page with the switch off', async () => {
    const fake = new DevicesFake({ enabled: true });
    await mount(fake);
    expect(q('[data-testid="devices-empty"]')!.textContent).toContain('No other PC yet');
    await click(q('[data-testid="add-device"]'));
    expect(q('[data-testid="add-device-sheet"]')).not.toBeNull();
    // The first thing is the link; the older ways are one step away, folded.
    expect(q('[data-testid="far-tab"]')).not.toBeNull();
    expect(q<HTMLDetailsElement>('[data-testid="add-more"]')!.open).toBe(false);
    expect(q('[data-testid="join-address"]')).toBeNull();
    expect(q<HTMLButtonElement>('[data-testid="add-tab-ssh"]')!.disabled).toBe(false);
    await click(q('[data-testid="add-tab-code"]'));
    await typeInto(q<HTMLInputElement>('[data-testid="join-address"]')!, 'pm1:' + 'f6'.repeat(32) + '@192.168.1.20:47111');
    await typeInto(q<HTMLInputElement>('[data-testid="join-code"]')!, '4f7q-9k2m');
    await click(q('[data-testid="join-go"]'));
    await settle(6);
    // Both people confirm: this PC's sheet shows the same code.
    const confirm = q('[data-testid="pair-confirm"]')!;
    expect(confirm.textContent).toContain('"Studio PC" wants to pair. Code 4F7Q-9K2M.');
    await click(q('[data-testid="pair-allow"]'));
    await settle(8);
    expect(q('[data-testid="pair-confirm"]')).toBeNull();
    expect(q('[data-testid="add-device-sheet"]')).toBeNull();
    // The pairing line is ours now: a confirmation, then the device's own next step with the button to its rights.
    expect(q('[data-testid="devices-message"]')!.textContent).toBe('Connected to Studio PC.');
    expect(document.body.textContent).not.toContain('Nothing is shared yet');
    const item = document.querySelector<HTMLElement>('.dev-item')!;
    expect(item.textContent).toContain('Studio PC');
    expect(fake.view.devices[0]!.lets_run).toBe(false);
    const nextStep = document.querySelector<HTMLElement>('[data-testid^="device-next-"]')!;
    expect(nextStep.textContent).toContain('Nothing is allowed for it on this PC yet.');
    // The one button opens that device's rights choice.
    await click(document.querySelector('[data-testid^="device-choose-"]'));
    expect(q('[data-testid="device-page"]')).not.toBeNull();
    expect(q('[data-testid="device-rights"]')).not.toBeNull();
    expect(q<HTMLInputElement>('[data-testid="perm-agents"]')!.checked).toBe(false);
    expect(q('[data-testid="level-watch"]')).toBeNull();
    // Turning the switch on shows the level, and the level is Watch and answer or Full control.
    await click(q('[data-testid="perm-agents"]'));
    await settle(4);
    expect(fake.view.devices[0]!.lets_run).toBe(true);
    await click(q('[data-testid="level-full"]'));
    await settle(4);
    expect(fake.view.devices[0]!.level).toBe('full');
  });

  it('a device that may do nothing here says what it may do and the button opens its rights choice', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [MAC_MINI] });
    await mount(fake);
    // The row keeps its state line and gains one next step: nothing yet, one button.
    expect(q(`[data-testid="device-${NODE_MAC}"]`)!.textContent).toContain('Online · same network');
    const nextStep = q(`[data-testid="device-next-${NODE_MAC}"]`)!;
    expect(nextStep.textContent).toContain('Nothing is allowed for it on this PC yet.');
    expect(nextStep.querySelector('button')!.textContent).toBe('Choose what it may do');
    await click(q(`[data-testid="device-choose-${NODE_MAC}"]`));
    expect(q('[data-testid="device-page"]')).not.toBeNull();
    expect(q('[data-testid="device-rights"]')!.textContent).toContain('Run agents and terminals here');
    expect(q<HTMLInputElement>('[data-testid="perm-agents"]')!.checked).toBe(false);
    // Once a right is on, the next step is gone again.
    await click(q('[data-testid="perm-files"]'));
    await settle(6);
    await click(q('[data-testid="device-back"]'));
    await settle(4);
    expect(q(`[data-testid="device-next-${NODE_MAC}"]`)).toBeNull();
  });

  it('a device the other PC refuses names the right that is off and offers the same button', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [{ ...MAC_MINI, state: 'not_allowed' }] });
    await mount(fake);
    const nextStep = q(`[data-testid="device-next-${NODE_MAC}"]`)!;
    expect(nextStep.textContent).toContain('Run agents and terminals here is still off for Mac mini.');
    await click(q(`[data-testid="device-choose-${NODE_MAC}"]`));
    // The device page carries the same line, and its rights choice is right below.
    expect(q('[data-testid="device-page"]')!.textContent).toContain('Run agents and terminals here is still off for Mac mini.');
    expect(q(`[data-testid="device-next-${NODE_MAC}"]`)).not.toBeNull();
    expect(q('[data-testid="device-rights"]')).not.toBeNull();
  });

  it('the other device typing my code opens the same confirm sheet, and No pairs nothing', async () => {
    const fake = new DevicesFake({ enabled: true });
    await mount(fake);
    await click(q('[data-testid="show-code"]'));
    await settle(6);
    expect(q('[data-testid="the-code"]')!.textContent).toBe('4F7Q-9K2M');
    expect(q<HTMLInputElement>('[data-testid="the-address"]')!.value).toMatch(/^pm1:/);
    await act(async () => fake.simulateIncoming('Desk-PC', '4F7Q-9K2M'));
    await settle(4);
    expect(q('[data-testid="pair-confirm"]')!.textContent).toContain('"Desk-PC" wants to pair.');
    await click(q('[data-testid="pair-no"]'));
    await settle(4);
    expect(fake.view.devices).toHaveLength(0);
  });

  it('lists devices with the route chip and one plain word, and the device page names the state', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [MAC_MINI, WORK_LAPTOP] });
    await mount(fake);
    const items = [...document.querySelectorAll('.dev-item')].map((i) => i.textContent);
    expect(items[0]).toContain('Mac mini');
    expect(items[0]).toContain('Direct');
    expect(items[1]).toContain('Work laptop');
    expect(items[1]).toContain('offline');
    await act(async () => fake.setDevice(NODE_MAC, { path: 'relay' }));
    await settle(4);
    expect(document.querySelector('.dev-item')!.textContent).toContain('Public link');
    await act(async () => fake.setDevice(NODE_MAC, { path: 'own' }));
    await settle(4);
    expect(document.querySelector('.dev-item')!.textContent).toContain('Your link');
  });

  it('two PCs with the same name show a short id after the name; different names stay plain', async () => {
    const twin = { ...MAC_MINI, node: 'ab12' + MAC_MINI.node.slice(4) };
    const fake = new DevicesFake({ enabled: true, devices: [MAC_MINI, twin, WORK_LAPTOP] });
    await mount(fake);
    const names = [...document.querySelectorAll('.dev-item b')].map((b) => b.textContent);
    expect(names).toEqual([`Mac mini · ${MAC_MINI.node.slice(0, 4)}`, 'Mac mini · ab12', 'Work laptop']);
    await act(async () => click(document.querySelectorAll<HTMLElement>('.dev-item')[1]!));
    await settle(4);
    expect(q('[data-testid="device-page"] h3')!.textContent).toBe('Mac mini · ab12');
  });

  it('a lend screen can open one device page straight away, from the list or while it is already open', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [MAC_MINI, WORK_LAPTOP] });
    // Asked for before the page mounts (a borrow form's "Open the switch"): it lands on that device.
    openDeviceAt(NODE_MAC);
    await mount(fake);
    expect(q('[data-testid="device-page"]')).not.toBeNull();
    expect(q('[data-testid="device-page"]')!.getAttribute('aria-label')).toBe('Mac mini');
    expect(q<HTMLInputElement>('[data-testid="perm-lend"]')!.checked).toBe(false);
    // The page is open on Mac mini: a second ask for the other PC switches to it at once.
    await act(async () => openDeviceAt(NODE_LAPTOP));
    await settle(4);
    expect(q('[data-testid="device-page"]')!.getAttribute('aria-label')).toBe('Work laptop');
  });

  it('How my PCs reach each other: three choices in plain words, one chosen, saved through the command', async () => {
    const fake = new DevicesFake({ enabled: true });
    await mount(fake);
    const radios = [...document.querySelectorAll<HTMLInputElement>('[data-testid="route-setting"] input[type="radio"]')];
    expect(radios.map((r) => r.checked)).toEqual([true, false, false]);
    expect(q('[data-testid="route-setting"]')!.textContent).toContain('How my PCs reach each other');
    await click(q('[data-testid="route-own"]'));
    await settle(4);
    expect(fake.view.route_pref).toBe('own');
    expect(q('[data-testid="route-setting"]')!.textContent).toContain('You have no relay yet. Set one up at the top of Connect.');
  });

  it('Remove device asks first, then both PCs forget each other', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [MAC_MINI] });
    await mount(fake);
    await click(document.querySelector('.dev-item'));
    await click(q('[data-testid="remove-device"]'));
    expect(document.body.textContent).toContain('Remove Mac mini?');
    expect(fake.view.devices).toHaveLength(1);
    await click(q('[data-testid="remove-yes"]'));
    await settle(6);
    expect(fake.view.devices).toHaveLength(0);
    expect(q('[data-testid="devices-empty"]')).not.toBeNull();
  });

  it('removing a device also forgets its kept transcripts and drafts here, and only its own', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [MAC_MINI] });
    const node = MAC_MINI.node;
    window.localStorage.setItem(`pm.remoteChat.device:${node}:p1`, '[]');
    window.localStorage.setItem('pm.remoteChat.device:other:p1', '[]');
    window.localStorage.setItem('pm.composerDrafts', JSON.stringify({ [`device:${node}:p1`]: { text: 'a', at: Date.now() }, 'device:other:p1': { text: 'b', at: Date.now() } }));
    await mount(fake);
    await click(document.querySelector('.dev-item'));
    await click(q('[data-testid="remove-device"]'));
    await click(q('[data-testid="remove-yes"]'));
    await settle(6);
    expect(window.localStorage.getItem(`pm.remoteChat.device:${node}:p1`)).toBeNull();
    expect(window.localStorage.getItem('pm.remoteChat.device:other:p1')).not.toBeNull();
    expect(Object.keys(JSON.parse(window.localStorage.getItem('pm.composerDrafts')!))).toEqual(['device:other:p1']);
  });

  it('a PC that vanishes from the list (the other side unlinked it) takes its kept local state with it', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [MAC_MINI] });
    const node = MAC_MINI.node;
    window.localStorage.setItem(`pm.remoteChat.device:${node}:p1`, '[]');
    window.localStorage.setItem(`pm.view.dev:${node}:p1`, 'chat');
    window.localStorage.setItem('pm.remoteChat.device:other:p1', '[]');
    await mount(fake);
    await settle(3);
    expect(window.localStorage.getItem(`pm.remoteChat.device:${node}:p1`)).not.toBeNull();
    await act(async () => {
      fake.view.devices = [];
      (fake as unknown as { emit(): void }).emit();
    });
    await settle(3);
    expect(window.localStorage.getItem(`pm.remoteChat.device:${node}:p1`)).toBeNull();
    expect(window.localStorage.getItem(`pm.view.dev:${node}:p1`)).toBeNull();
    expect(window.localStorage.getItem('pm.remoteChat.device:other:p1')).not.toBeNull();
  });

  it('with the Labs switch off nothing renders', async () => {
    const fake = new DevicesFake({ enabled: false, devices: [MAC_MINI] });
    await mount(fake);
    expect(host.innerHTML).toBe('');
  });

  it('Settings has no Devices page (it is the My PCs tab of Connect); the Labs list still carries its switch', () => {
    const rows = (flag: boolean) =>
      visibleSections(SECTIONS, { devices_enabled: flag })
        .flatMap((s) => s.rows)
        .map((r) => r.id);
    expect(rows(true)).not.toContain('devices-page');
    expect(rows(false)).not.toContain('devices-page');
    expect(rows(false)).toContain('labs-index');
  });
});
