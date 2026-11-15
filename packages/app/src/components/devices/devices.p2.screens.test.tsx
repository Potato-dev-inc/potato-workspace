// @vitest-environment jsdom
// Devices phase 2, through the real components; only the devices command layer is the fake (`DevicesFake`) and the phone list
// of Settings > Phone is a stub. Proves: the remote banner lines, the live terminal, Device activity, the per-device route and
// the web switch, Add a device > Far away, the Phones section, the far side's Connected banner, and Labs off draws nothing.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevicesFake, MAC_MINI, MAC_PANES, NODE_MAC } from '../../dev/devices-fixtures';
import type { ActivityEntry } from '../../lib/devices';
import { click, pickOption, settle, type as typeInto } from '../settings/test-utils';
import { ConnectedBanner } from './ConnectedBanner';
import { DevicesPage } from './DevicesPage';
import { RemotePaneView } from './RemotePaneView';

vi.mock('../../lib/tauri', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../lib/tauri')>();
  return {
    ...orig,
    tauri: {
      ...orig.tauri,
      listPairedMobileDevices: vi.fn(async () => [{ id: 'ph1', name: 'Pixel 8', public_key: 'k', paired_at: 1, caps: ['watch'], expires_at: 2_000_000_000, last_seen: 1, expired: false, idle_expiry_secs: 86400 }]),
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
const at = (h: number, m: number) => Math.floor(new Date(2026, 10, 15, h, m).getTime() / 1000);

describe('the remote view: states and notices', () => {
  const mountRemote = async (fake: DevicesFake, row: { agent?: string; chat?: boolean } = {}) => {
    const device = fake.view.devices[0]!;
    await act(async () => root.render(<RemotePaneView device={device} row={{ paneId: 'p2', chat: row.chat ?? false, title: 'Terminal', agent: row.agent }} api={fake} onRetry={() => void fake.state()} />));
    await settle(6);
  };

  it('shows the signed-out line with its hint and the needs-a-person line at the top', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [{ ...MAC_MINI, signed_out: ['claude', 'codex'], needs_person: [{ pane: 'p2', what: 'a password box is open there' }] }], panes: { [NODE_MAC]: MAC_PANES } });
    await mountRemote(fake, { agent: 'claude' });
    const text = q('[data-testid="remote-pane"]')!.textContent!;
    expect(text).toContain('Claude is signed out on Mac mini.');
    expect(text).toContain('Sign in on Mac mini. Sign-ins stay on their own device.');
    expect(text).not.toContain('Codex is signed out');
    expect(text).toContain('Needs a person at Mac mini: a password box is open there');
  });

  it('says asleep and offers Try again; closed has no button', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [{ ...MAC_MINI, state: 'asleep', path: null }] });
    await mountRemote(fake);
    expect(q('[data-testid="device-notices"]')!.textContent).toContain('Asleep or off.');
    const before = fake.stateCalls;
    await click(q('[data-testid="try-again"]'));
    expect(fake.stateCalls).toBeGreaterThan(before);
    await act(async () => root.unmount());
    root = createRoot(host);
    const closed = new DevicesFake({ enabled: true, devices: [{ ...MAC_MINI, state: 'closed', path: null }] });
    await mountRemote(closed);
    expect(q('[data-testid="device-notices"]')!.textContent).toContain('Potato Workspace is closed on Mac mini.');
    expect(q('[data-testid="try-again"]')).toBeNull();
  });

  it('says the device is too old', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [{ ...MAC_MINI, too_old: true }] });
    await mountRemote(fake);
    expect(q('[data-testid="device-notices"]')!.textContent).toContain('Mac mini runs an older Potato Workspace. Update it to connect.');
  });
});

describe('the live terminal', () => {
  const live = async (fake: DevicesFake) => {
    await act(async () => root.render(<RemotePaneView device={fake.view.devices[0]!} row={{ paneId: 'p2', chat: false, title: 'Terminal' }} api={fake} />));
    await settle(6);
  };

  it('starts on mount, draws what the far side pushes, ignores other panes and devices, and stops on unmount', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [MAC_MINI], panes: { [NODE_MAC]: MAC_PANES } });
    await live(fake);
    expect(fake.screenStarts).toEqual([`${NODE_MAC}:p2`]);
    await act(async () => fake.emitScreen({ node: NODE_MAC, pane_id: 'p2', content: '$ make dmg' }));
    expect(q('[data-testid="remote-screen"]')!.textContent).toBe('$ make dmg');
    await act(async () => fake.emitScreen({ node: NODE_MAC, pane_id: 'p9', content: 'other pane' }));
    await act(async () => fake.emitScreen({ node: 'b2'.repeat(32), pane_id: 'p2', content: 'other device' }));
    expect(q('[data-testid="remote-screen"]')!.textContent).toBe('$ make dmg');
    await act(async () => fake.emitScreen({ node: NODE_MAC, pane_id: 'p2', content: '$ make dmg\nDone.' }));
    expect(q('[data-testid="remote-screen"]')!.textContent).toContain('Done.');
    expect(fake.requests.some((r) => r.path.endsWith('/snapshot'))).toBe(false);
    expect(fake.screenStops).toEqual([]);
    await act(async () => root.unmount());
    root = createRoot(host);
    expect(fake.screenStops).toEqual([`${NODE_MAC}:p2`]);
    expect(fake.screens.size).toBe(0);
  });

  it('reads one snapshot when the far side cannot stream', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [MAC_MINI], panes: { [NODE_MAC]: MAC_PANES } });
    fake.screenFails = true;
    await live(fake);
    expect(q('[data-testid="remote-screen"]')!.textContent).toContain('make dmg');
    expect(fake.requests.filter((r) => r.path.endsWith('/snapshot'))).toHaveLength(1);
  });

  it('does not start while the device is offline', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [{ ...MAC_MINI, state: 'offline', path: null }] });
    await live(fake);
    expect(fake.screenStarts).toEqual([]);
  });
});

describe('Settings > Devices > a device', () => {
  const ACTIVITY: ActivityEntry[] = [
    { at: at(14, 2), node: NODE_MAC, name: 'Mac mini', dir: 'in', kind: 'started' },
    { at: at(14, 11), node: NODE_MAC, name: 'Mac mini', dir: 'out', kind: 'stopped' },
    { at: at(13, 0), node: 'b2'.repeat(32), name: 'Elsewhere', dir: 'in', kind: 'typed' },
  ];
  const open = async (fake: DevicesFake) => {
    await act(async () => root.render(<DevicesPage api={fake} />));
    await settle(6);
    await click(q('.dev-item'));
    await settle(4);
  };

  it('lists the device activity newest first, on both sides, for this device only', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [MAC_MINI], activity: ACTIVITY });
    await open(fake);
    const lines = [...document.querySelectorAll('[data-testid="device-activity"] li')].map((li) => li.textContent);
    expect(lines).toEqual(['14:11 Stopped an agent on Mac mini', '14:02 Mac mini started an agent']);
  });

  it('says nothing yet when there is no activity', async () => {
    await open(new DevicesFake({ enabled: true, devices: [MAC_MINI] }));
    expect(q('[data-testid="activity-none"]')!.textContent).toBe('Nothing yet.');
  });

  it('lets one device have its own route, and null follows this PC', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [MAC_MINI] });
    await open(fake);
    const select = q<HTMLSelectElement>('[data-testid="device-route"]')!;
    expect([...select.options].map((o) => o.textContent)).toEqual(['Same as this PC', 'Automatic', 'Public relay only', 'My own route only']);
    expect(select.value).toBe('same');
    await pickOption(select, 'own');
    await settle(4);
    expect(fake.view.devices[0]!.route_override).toBe('own');
    expect(q('[data-testid="route-no-web"]')!.textContent).toContain('This PC has no web address for Mac mini yet.');
    await pickOption(q<HTMLSelectElement>('[data-testid="device-route"]')!, 'same');
    await settle(4);
    expect(fake.view.devices[0]!.route_override).toBeNull();
  });

  it('shows the web switch only while the device may run agents, and it saves', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [MAC_MINI] });
    await open(fake);
    expect(q('[data-testid="perm-web"]')).toBeNull();
    await click(q('[data-testid="perm-agents"]'));
    await settle(4);
    const web = q<HTMLInputElement>('[data-testid="perm-web"]')!;
    expect(web.closest('label')!.textContent).toContain('Also allow it through my web address');
    await click(web);
    await settle(4);
    expect(fake.view.devices[0]!.lets_web).toBe(true);
  });

  it('names the state and offers Try again for a device that is asleep', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [{ ...MAC_MINI, state: 'asleep', path: null }] });
    await open(fake);
    expect(q('[data-testid="device-page"]')!.textContent).toContain('Asleep or off.');
    const before = fake.stateCalls;
    await click(q('[data-testid="try-again"]'));
    await settle(3);
    expect(fake.stateCalls).toBeGreaterThan(before);
  });
});

describe('Settings > Devices > Add a device > Far away', () => {
  const addSheet = async (fake: DevicesFake) => {
    await act(async () => root.render(<DevicesPage api={fake} />));
    await settle(6);
    await click(q('[data-testid="add-device"]'));
    await click(q('[data-testid="add-tab-far"]'));
  };

  it('makes a pairing link and shows it with Copy and what to know', async () => {
    const fake = new DevicesFake({ enabled: true });
    await addSheet(fake);
    await click(q('[data-testid="make-link"]'));
    await settle(4);
    const box = q<HTMLTextAreaElement>('[data-testid="the-link"]')!;
    expect(box.readOnly).toBe(true);
    expect(box.value).toMatch(/^pm1link:/);
    expect(q('[data-testid="copy-link"]')!.textContent).toBe('Copy');
    expect(q('[data-testid="far-tab"]')!.textContent).toContain('Valid 10 minutes. Works once. Both people still confirm.');
    // Closing the sheet withdraws the link.
    await click(document.querySelector('.dev-actions .dev-btn'));
    await settle(3);
    expect(fake.view.hosting).toBeNull();
  });

  it('pastes a link, joins with it, and both people confirm as with a code', async () => {
    const fake = new DevicesFake({ enabled: true });
    await addSheet(fake);
    expect(q<HTMLButtonElement>('[data-testid="join-link-go"]')!.disabled).toBe(true);
    await typeInto(q<HTMLInputElement>('[data-testid="paste-link"]')!, '  pm1link:abc123  ');
    await click(q('[data-testid="join-link-go"]'));
    await settle(6);
    expect(fake.joinLinks).toEqual(['pm1link:abc123']);
    expect(q('[data-testid="pair-confirm"]')!.textContent).toContain('wants to pair');
    await click(q('[data-testid="pair-allow"]'));
    await settle(8);
    expect(q('[data-testid="add-device-sheet"]')).toBeNull();
    expect(fake.view.devices).toHaveLength(1);
  });

  it('shows the error text when the link is refused (for example the relay is off)', async () => {
    const fake = new DevicesFake({ enabled: true });
    await addSheet(fake);
    await typeInto(q<HTMLInputElement>('[data-testid="paste-link"]')!, 'not a link');
    await click(q('[data-testid="join-link-go"]'));
    await settle(4);
    expect(q('[data-testid="far-tab"] [role="alert"]')!.textContent).toContain('That link does not look right.');
    expect(q<HTMLButtonElement>('[data-testid="join-link-go"]')!.disabled).toBe(false);
  });

  it('Show a code shows the link while this PC is hosting one', async () => {
    const fake = new DevicesFake({ enabled: true });
    await act(async () => root.render(<DevicesPage api={fake} />));
    await settle(6);
    await click(q('[data-testid="show-code"]'));
    await settle(4);
    expect(q('[data-testid="the-code"]')).not.toBeNull();
    await act(async () => void fake.makeLink());
    await settle(4);
    expect(q('[data-testid="show-code-sheet"] [data-testid="the-link"]')).not.toBeNull();
    expect(q('[data-testid="the-code"]')).toBeNull();
  });
});

describe('Settings > Devices: routes and phones', () => {
  it('"My own route" says how it works, and the setup step only while it is not ready', async () => {
    const fake = new DevicesFake({ enabled: true, route_pref: 'own', own_route_ready: false });
    await act(async () => root.render(<DevicesPage api={fake} />));
    await settle(6);
    const text = q('[data-testid="route-setting"]')!.textContent!;
    expect(text).toContain('Direct on the same network, otherwise through your own web address');
    expect(q('[data-testid="route-own-setup"]')!.textContent).toContain('Settings › Phone › Public address');
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => root.render(<DevicesPage api={new DevicesFake({ enabled: true, route_pref: 'own', own_route_ready: true })} />));
    await settle(6);
    expect(q('[data-testid="route-own-setup"]')).toBeNull();
  });

  it('the Devices page has a Phones section with the paired phones and a way to pair one', async () => {
    const onOpenPhone = vi.fn();
    await act(async () => root.render(<DevicesPage api={new DevicesFake({ enabled: true, devices: [MAC_MINI] })} onOpenPhone={onOpenPhone} />));
    await settle(8);
    const section = q('[data-testid="phones-section"]')!;
    expect(section.textContent).toContain('Pixel 8');
    expect(section.querySelector('[data-testid="paired-devices"]')).not.toBeNull();
    expect(document.body.textContent).toContain('Phones');
    await click(q('[data-testid="pair-phone"]'));
    expect(onOpenPhone).toHaveBeenCalledOnce();
  });
});

describe('the far side: Connected banner', () => {
  it('names who is connected and how much, and Disconnect closes it', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [{ ...MAC_MINI, lets_run: true, level: 'full', connected: true }] });
    const done = vi.fn();
    await act(async () => root.render(<ConnectedBanner view={fake.view} api={fake} onDone={done} />));
    expect(q('[data-testid="connected-banner"]')!.textContent).toContain('Mac mini is connected · Full control');
    await click(q(`[data-testid="disconnect-${NODE_MAC}"]`));
    await settle(3);
    expect(fake.view.devices[0]!.connected).toBe(false);
    expect(fake.view.devices[0]!.lets_run).toBe(false);
    expect(done).toHaveBeenCalled();
  });

  it('draws nothing when nobody is connected, the device has no rights, or Labs is off', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [{ ...MAC_MINI, lets_run: true, connected: false }, { ...MAC_MINI, node: 'b2'.repeat(32), lets_run: false, connected: true }] });
    await act(async () => root.render(<ConnectedBanner view={fake.view} api={fake} />));
    expect(host.innerHTML).toBe('');
    const off = new DevicesFake({ enabled: false, devices: [{ ...MAC_MINI, lets_run: true, connected: true }] });
    await act(async () => root.render(<ConnectedBanner view={off.view} api={off} />));
    expect(host.innerHTML).toBe('');
    await act(async () => root.render(<ConnectedBanner view={null} api={off} />));
    expect(host.innerHTML).toBe('');
  });
});

describe('Labs off', () => {
  it('draws nothing on the Devices page', async () => {
    await act(async () => root.render(<DevicesPage api={new DevicesFake({ enabled: false, devices: [MAC_MINI] })} />));
    await settle(6);
    expect(host.innerHTML).toBe('');
  });
});

describe('agents may send work to a device', () => {
  const open = async (fake: DevicesFake) => {
    await act(async () => root.render(<DevicesPage api={fake} />));
    await settle(6);
    await click(q('.dev-item'));
    await settle(4);
  };

  it('is off by default, sits under the agents switch, and the switch calls the api', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [MAC_MINI] });
    await open(fake);
    const sw = q<HTMLInputElement>('[data-testid="perm-send-work"]')!;
    expect(sw.closest('label')!.textContent).toContain('Agents may send work to this device');
    expect(sw.closest('label')!.textContent).toContain('Off by default');
    expect(sw.checked).toBe(false);
    await click(sw);
    await settle(4);
    expect(fake.view.devices[0]!.agents_may_send).toBe(true);
    expect(q<HTMLInputElement>('[data-testid="perm-send-work"]')!.checked).toBe(true);
    await click(q('[data-testid="perm-send-work"]'));
    await settle(4);
    expect(fake.view.devices[0]!.agents_may_send).toBe(false);
  });
});

describe('Borrow my agent sign-ins (lending over the device link)', () => {
  const open = async (fake: DevicesFake) => {
    await act(async () => root.render(<DevicesPage api={fake} />));
    await settle(6);
    await click(q('.dev-item'));
    await settle(4);
  };

  it('is off by default, stands on its own, and the switch calls the api both ways', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [MAC_MINI] });
    await open(fake);
    const sw = q<HTMLInputElement>('[data-testid="perm-lend"]')!;
    expect(sw.closest('label')!.textContent).toContain('Borrow my agent sign-ins');
    expect(sw.closest('label')!.textContent).toContain('The sign-in never leaves it');
    expect(sw.checked).toBe(false);
    expect(fake.view.devices[0]!.lets_run).toBe(false);
    await click(sw);
    await settle(4);
    expect(fake.view.devices[0]!.lets_lend).toBe(true);
    expect(fake.view.devices[0]!.lets_run).toBe(false);
    expect(q<HTMLInputElement>('[data-testid="perm-lend"]')!.checked).toBe(true);
    await click(q('[data-testid="perm-lend"]'));
    await settle(4);
    expect(fake.view.devices[0]!.lets_lend).toBe(false);
  });
});
