// @vitest-environment jsdom
// The Connect page as whole screens, through the real components (PairedDevices, MobilePairingPanel, DevicesPage, TeamHost,
// LendPage, RequestUsage). Only the command layers are fakes (settings, paired phones, DevicesFake, the fake lend backend and a
// fake team). Proves: the page has the four tabs; each tab shows what is connected and its one main button; "Sign-ins stay on
// their own device" is said once; a switched-off tab offers the switch; the old Settings rows link to the matching tab (and keep
// their own content where there is no Connect page); and the sidebar row opens the page.
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PairedDeviceInfo, Settings } from '@potato-workspace/shared';
import { DevicesFake, MAC_MINI } from '../../dev/devices-fixtures';
import { createFakeLendApi, GRANT_IN, GRANT_OUT, lendState } from '../../dev/lend-fixtures';
import { teamConfig, teamState } from '../../dev/team-fixtures';
import type { CockpitApi } from '../../hooks/useCockpit';
import { connectTabFor, registerConnectOpener, type ConnectTab } from '../../lib/openConnect';
import type { ShipApi } from '../../lib/ship-api';
import type { TeamApi } from '../../lib/team';
import { Sidebar } from '../cockpit/Sidebar';
import { RowShell } from '../settings/SectionView';
import { devicesRows } from '../settings/sections/DevicesSection';
import { lendRows } from '../settings/sections/LendSection';
import { phoneRows } from '../settings/sections/PhoneSection';
import { teamRows } from '../settings/sections/TeamSection';
import { BASE_SETTINGS, click, makeEnv, settle } from '../settings/test-utils';
import { resetRememberedTab } from '../team-page/TeamPage';
import { ConnectPage, type ConnectApi } from './ConnectPage';

vi.mock('qrcode', () => ({ default: { toCanvas: vi.fn(async () => undefined) } }));
vi.mock('../settings/TunnelSection', () => ({ TunnelSection: () => <div data-testid="tunnel-stub" /> }));

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
  resetRememberedTab();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  registerConnectOpener(null);
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = '';
});

const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const text = (sel: string) => q(sel)?.textContent ?? '';

const PHONE: PairedDeviceInfo = { id: 'p1', name: "Ren's iPhone", created_at: 1, last_seen: 1, expired: false } as unknown as PairedDeviceInfo;

function fakeTeam(active: boolean): TeamApi {
  return {
    state: async () => teamState({ active, presence: [] }),
    configGet: async () => teamConfig(active ? {} : { team: '' }),
    defaultName: async () => 'Leo',
    onChanged: async () => () => {},
    onDraft: async () => () => {},
  } as unknown as TeamApi;
}

function makeApi(over: { settings?: Partial<Settings>; phones?: PairedDeviceInfo[]; devices?: DevicesFake; team?: TeamApi; lend?: ReturnType<typeof createFakeLendApi> } = {}): Partial<ConnectApi> & { settingsPatches: unknown[] } {
  const settingsPatches: unknown[] = [];
  let settings = { ...BASE_SETTINGS, lend_enabled: true, devices_enabled: true, ...over.settings } as Settings;
  return {
    settingsPatches,
    loadSettings: async () => settings,
    patchSettings: async (p) => {
      settingsPatches.push(p);
      settings = { ...settings, ...(p as object) } as Settings;
      return settings;
    },
    listPhones: async () => over.phones ?? [],
    devices: over.devices ?? new DevicesFake({ enabled: true }),
    team: over.team ?? fakeTeam(false),
    lend: over.lend ?? createFakeLendApi(lendState({ grants: [] })),
  };
}

function Screen({ api, start = 'phone' }: { api: Partial<ConnectApi>; start?: ConnectTab }) {
  const [tab, setTab] = useState<ConnectTab>(start);
  // The cockpit registers how to show the page on a tab; the old Settings links use it.
  registerConnectOpener(setTab);
  return <ConnectPage tab={tab} onTab={setTab} api={api} />;
}

async function mount(api: Partial<ConnectApi>, start: ConnectTab = 'phone') {
  await act(async () => root.render(<Screen api={api} start={start} />));
  await settle(8);
}
async function pick(tab: ConnectTab) {
  await click(q(`[data-testid="connect-tab-${tab}"]`));
  await settle(8);
}

describe('Connect page', () => {
  it('has four tabs and says "Sign-ins stay on their own device" once', async () => {
    await mount(makeApi());
    const tabs = [...document.querySelectorAll('[role="tab"]')].map((t) => t.textContent);
    expect(tabs).toEqual(['Phone', 'My PCs', 'Team', 'Lending']);
    expect(q('[data-testid="connect-tab-phone"]')!.getAttribute('aria-selected')).toBe('true');
    expect(document.body.textContent!.match(/Sign-ins stay on their own device/g)).toHaveLength(1);
    // Still once after visiting every tab.
    for (const tab of ['pcs', 'team', 'lending'] as const) await pick(tab);
    expect(document.body.textContent!.match(/Sign-ins stay on their own device/g)).toHaveLength(1);
  });

  it('Phone: no phone yet -> says so, with Pair a phone as the main button that opens the pairing panel', async () => {
    await mount(makeApi());
    expect(text('[data-testid="connect-status-phone"]')).toBe('No phone is paired yet.');
    const main = q<HTMLButtonElement>('[data-testid="connect-main-phone"]')!;
    expect(main.textContent).toBe('Pair a phone');
    expect(main.className).toContain('ck-btn--primary');
    expect(q('[data-testid="connect-pairing"]')).toBeNull();
    await click(main);
    expect(q('[data-testid="connect-pairing"]')).not.toBeNull();
    expect(q('[data-testid="pairing-panel"]')).not.toBeNull();
    // The address is behind its own button, not in the way.
    expect(q('[data-testid="connect-tunnel"]')).toBeNull();
    await click(q('[data-testid="connect-address"]'));
    await settle(4);
    expect(q('[data-testid="tunnel-stub"]')).not.toBeNull();
  });

  it('Phone: a paired phone is counted', async () => {
    await mount(makeApi({ phones: [PHONE] }));
    expect(text('[data-testid="connect-status-phone"]')).toBe('1 phone is paired.');
    expect(q('[data-testid="connect-status-phone"]')!.getAttribute('data-on')).toBe('true');
  });

  it('My PCs: lists the paired PC first, then Add another PC as the main button', async () => {
    const devices = new DevicesFake({ enabled: true, devices: [MAC_MINI] });
    await mount(makeApi({ devices }));
    await pick('pcs');
    expect(text('[data-testid="connect-status-pcs"]')).toBe('1 other PC is paired · 1 online.');
    const list = q('.dev-list')!;
    const add = q('[data-testid="add-device"]')!;
    expect(list.textContent).toContain('Mac mini');
    expect(add.className).toContain('is-primary');
    // What is connected comes before the button.
    expect(list.compareDocumentPosition(add) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Phones have their own tab: no phones block here, and the Devices blurb is not repeated.
    expect(q('[data-testid="phones-section"]')).toBeNull();
    await click(add);
    expect(q('[data-testid="add-device-sheet"]')).not.toBeNull();
  });

  it('My PCs: switched off -> one block with the switch; it turns the feature on', async () => {
    const api = makeApi({ settings: { devices_enabled: false }, devices: new DevicesFake({ enabled: false }) });
    await mount(api);
    await pick('pcs');
    expect(text('[data-testid="connect-status-pcs"]')).toBe('No other PC is paired yet.');
    const off = q('[data-testid="connect-pcs-off"]')!;
    expect(off.querySelector('.ck-empty-title')!.textContent).toBe('Use more than one PC');
    await click([...off.querySelectorAll('button')].find((b) => b.textContent === 'Turn on My PCs'));
    expect(api.settingsPatches).toEqual([{ devices_enabled: true }]);
  });

  it('Team: not in a team -> says so, and Start a team is the main button', async () => {
    await mount(makeApi());
    await pick('team');
    expect(text('[data-testid="connect-status-team"]')).toBe('You are not in a team yet.');
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="connect-panel-team"] button')].map((b) => b.textContent);
    expect(buttons).toContain('Start a team');
    expect(buttons).toContain('I have an invite');
  });

  it('Team: in a team -> counts the others and shows the team page', async () => {
    await mount(makeApi({ team: fakeTeam(true) }));
    await pick('team');
    expect(text('[data-testid="connect-status-team"]')).toMatch(/^You are in a team with \d+ other (person|people)\.$/);
    expect(q('[data-testid="team-page"]')).not.toBeNull();
  });

  it('Lending: shows what is lent and borrowed, and Ask to borrow is the main button', async () => {
    const lend = createFakeLendApi(lendState({ grants: [GRANT_OUT, GRANT_IN] }));
    await mount(makeApi({ lend }));
    await pick('lending');
    expect(text('[data-testid="connect-status-lending"]')).toBe('Lending 1 · borrowing 1.');
    const main = q('[data-testid="connect-main-lending"]')!;
    const ask = [...main.querySelectorAll('button')].find((b) => b.textContent === 'Ask to borrow');
    expect(ask).toBeDefined();
    await click(ask);
    expect(document.body.textContent).toContain('Ask to borrow');
  });

  it('Lending: switched off -> one block with the switch', async () => {
    const api = makeApi({ settings: { lend_enabled: false }, lend: createFakeLendApi({ enabled: false } as never) });
    await mount(api);
    await pick('lending');
    const off = q('[data-testid="connect-lending-off"]')!;
    expect(off.querySelector('.ck-empty-title')!.textContent).toBe('Lend or borrow an agent');
    await click([...off.querySelectorAll('button')].find((b) => b.textContent === 'Turn on lending'));
    expect(api.settingsPatches).toEqual([{ lend_enabled: true }]);
  });

  it('arrow keys move between the tabs', async () => {
    await mount(makeApi());
    const phone = q<HTMLButtonElement>('[data-testid="connect-tab-phone"]')!;
    await act(async () => {
      phone.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(q('[data-testid="connect-tab-pcs"]')!.getAttribute('aria-selected')).toBe('true');
  });
});

describe('Settings rows that moved to Connect', () => {
  const rowFor = (rows: typeof phoneRows, id: string) => rows.find((r) => r.id === id)!;

  it('each old Settings row is a link; pressing it lands on the matching Connect tab', async () => {
    const env = makeEnv();
    const cases: Array<[typeof phoneRows, string, ConnectTab]> = [
      [phoneRows, 'pairing', 'phone'],
      [phoneRows, 'paired-devices', 'phone'],
      [phoneRows, 'tunnel', 'phone'],
      [devicesRows, 'devices-page', 'pcs'],
      [teamRows, 'team-page', 'team'],
      [lendRows, 'lend-page', 'lending'],
    ];
    function Both({ row, startTab }: { row: (typeof phoneRows)[number]; startTab: ConnectTab }) {
      const [tab, setTab] = useState<ConnectTab>(startTab);
      registerConnectOpener(setTab);
      return (
        <>
          <RowShell row={row} env={env} />
          <ConnectPage tab={tab} onTab={setTab} api={makeApi()} />
        </>
      );
    }
    for (const [rows, id, tab] of cases) {
      const startTab: ConnectTab = tab === 'phone' ? 'team' : 'phone';
      await act(async () => root.render(<Both key={id} row={rowFor(rows, id)} startTab={startTab} />));
      await settle(6);
      expect(q('[data-testid="connect-tab-' + startTab + '"]')!.getAttribute('aria-selected')).toBe('true');
      const link = q(`[data-testid="connect-link-${tab}"]`)!;
      expect(link, id).not.toBeNull();
      await click(link.querySelector('button'));
      await settle(6);
      expect(q(`[data-testid="connect-tab-${tab}"]`)!.getAttribute('aria-selected'), id).toBe('true');
    }
  });

  it('keeps its own content in the Settings window, which has no Connect page', async () => {
    registerConnectOpener(null);
    await act(async () => root.render(<RowShell row={rowFor(teamRows, 'team-page')} env={makeEnv()} />));
    await settle(4);
    expect(q('[data-testid^="connect-link-"]')).toBeNull();
  });

  it('old Settings names resolve to a tab', () => {
    expect(connectTabFor('phone')).toBe('phone');
    expect(connectTabFor('pairing')).toBe('phone');
    expect(connectTabFor('devices')).toBe('pcs');
    expect(connectTabFor('team')).toBe('team');
    expect(connectTabFor('lend-page')).toBe('lending');
    expect(connectTabFor('theme')).toBeUndefined();
  });
});

describe('Sidebar Connect row', () => {
  function fakeCockpit(): CockpitApi {
    return {
      registry: { paneList: [], panes: new Map(), initialReady: true },
      names: new Map(),
      asked: { questions: [] },
      launchEntries: [{ type: 'codex', label: 'Codex' }],
      readyAgents: new Set<string>(),
      mode: 'orchestration',
      theme: 'dark',
      selectedId: null,
      select: vi.fn(),
      prompts: {},
      statusSince: new Map(),
      now: 60_000,
      spawn: null,
      toasts: [],
      notify: vi.fn(),
      openSettings: vi.fn(async () => {}),
      bridgeLine: '',
    } as unknown as CockpitApi;
  }
  const ship = { recent: vi.fn().mockResolvedValue([]), gitState: vi.fn().mockResolvedValue('repo') } as unknown as ShipApi;

  function Shell({ waiting = 0 }: { waiting?: number }) {
    const [open, setOpen] = useState(false);
    const [tab, setTab] = useState<ConnectTab>('phone');
    return (
      <div>
        <Sidebar c={fakeCockpit()} onOpenPalette={() => {}} ship={ship} connect={{ open, waiting }} onOpenConnect={() => setOpen(true)} />
        {open && <ConnectPage tab={tab} onTab={setTab} api={makeApi()} />}
      </div>
    );
  }

  it('opens the Connect page on Phone; the row is the active one; the team number shows on it', async () => {
    await act(async () => root.render(<Shell waiting={3} />));
    const row = q<HTMLButtonElement>('[data-testid="side-connect"]')!;
    expect(row.textContent).toContain('Connect');
    expect(q('[data-testid="side-connect-count"]')!.textContent).toBe('3');
    expect(q('[data-testid="connect-page"]')).toBeNull();
    await click(row);
    await settle(6);
    expect(q('[data-testid="connect-page"]')).not.toBeNull();
    expect(q('[data-testid="connect-tab-phone"]')!.getAttribute('aria-selected')).toBe('true');
    expect(q('[data-testid="side-connect"]')!.className).toContain('is-active');
  });

  it('shows no number when nothing waits', async () => {
    await act(async () => root.render(<Shell />));
    expect(q('[data-testid="side-connect-count"]')).toBeNull();
  });
});
