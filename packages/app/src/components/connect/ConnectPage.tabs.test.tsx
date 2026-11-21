// @vitest-environment jsdom
// Connect as whole screens: three tabs (Devices / Team / Lending), each in a brand-new, working and broken state, through the
// real components. Only the command layers are fakes. Proves the tab row and its memory, that Devices keeps "My phone" and
// "My PCs" apart (and shows the giant code when no phone is added), and that no technical word is on any screen.
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevicesFake, MAC_MINI, WORK_LAPTOP } from '../../dev/devices-fixtures';
import { createFakeLendApi, GRANT_OUT, lendState } from '../../dev/lend-fixtures';
import { setLanguagePref } from '../../i18n';
import { connectTabFor, CONNECT_TABS, normalizeConnectTab, rememberedConnectTab, type ConnectTab } from '../../lib/openConnect';
import { tauri } from '../../lib/tauri';
import { click, settle } from '../settings/test-utils';
import { resetRememberedTab } from '../team-page/TeamPage';
import { ConnectPage, type ConnectApi } from './ConnectPage';
import { fakeAccount, fakeTunnel, fakeTeam, harness, makeApi, PHONE, q, quick, stable, text, type Harness } from './connect-test-utils';

vi.mock('qrcode', () => ({ default: { toCanvas: vi.fn(async () => undefined), toString: vi.fn(async () => '<svg xmlns="http://www.w3.org/2000/svg"/>') } }));
vi.mock('../settings/TunnelSection', () => ({ TunnelSection: () => <div data-testid="tunnel-stub" /> }));

let h: Harness;
beforeEach(() => {
  window.localStorage.clear();
  setLanguagePref('en', false);
  resetRememberedTab();
  vi.spyOn(tauri, 'createMobilePairingSession').mockImplementation(async (bridgeUrl) => ({
    pairing_code: 'K7Q2M9XD',
    expires_at: Math.floor(Date.now() / 1000) + 600,
    server_public_key: 'a2V5',
    bridge_url: bridgeUrl,
    qr_payload: { v: 1, u: bridgeUrl, pk: 'a2V5', c: 'K7Q2M9XD', e: Math.floor(Date.now() / 1000) + 600 },
  }));
  h = harness();
});
afterEach(async () => {
  await h.unmount();
});

const FORBIDDEN = /relay|worker|tunnel|\bports?\b|\bnodes?\b|pairing|\bpair(?:ed)?\b|pm:|domain|subdomain/i;
const NO_FOLDS = /advanced|more options|technical details/i;
// The live checklist under This PC names the real parts on purpose (relay, tunnel program); the plain-words rule covers the rest.
const pageText = () => {
  const page = q('[data-testid="connect-page"]');
  if (!page) return '';
  const copy = page.cloneNode(true) as HTMLElement;
  copy.querySelectorAll('[data-testid="connect-steps"]').forEach((n) => n.remove());
  return copy.textContent ?? '';
};

function Screen({ api, start = 'devices' }: { api: Partial<ConnectApi>; start?: ConnectTab }) {
  const [tab, setTab] = useState<ConnectTab>(start);
  return <ConnectPage tab={tab} onTab={setTab} api={api} />;
}
let root: Root | null = null;
async function mountScreen(api: Partial<ConnectApi>, start: ConnectTab = 'devices') {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<Screen api={api} start={start} />));
  await settle(10);
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
});

describe('Connect > the tab row', () => {
  it('has three tabs: Devices, Team, Lending, and no old tab names', async () => {
    await h.mount(makeApi());
    const tabs = [...document.querySelectorAll('[role="tab"]')].map((t) => t.textContent);
    expect(tabs).toEqual(['Devices', 'Team', 'Lending']);
    expect(CONNECT_TABS).toEqual(['devices', 'team', 'lending']);
  });

  it('old tab names and Settings targets resolve to the three tabs', () => {
    expect(normalizeConnectTab('phone')).toBe('devices');
    expect(normalizeConnectTab('pcs')).toBe('devices');
    expect(normalizeConnectTab('lending')).toBe('lending');
    expect(normalizeConnectTab('nonsense')).toBe('devices');
    expect(connectTabFor('mobile')).toBe('devices');
    // The phone's own settings live in Settings now, not on Connect.
    for (const id of ['telegram', 'tunnel', 'revoke-all-devices', 'phone-notifications']) expect(connectTabFor(id)).toBeUndefined();
    expect(connectTabFor('devices')).toBe('devices');
    expect(connectTabFor('team-page')).toBe('team');
    expect(connectTabFor('lend-page')).toBe('lending');
    expect(connectTabFor('theme')).toBeUndefined();
  });

  it('switching shows that tab; the one used last is remembered', async () => {
    await mountScreen(makeApi());
    expect(q('[data-testid="connect-tab-devices"]')!.getAttribute('aria-selected')).toBe('true');
    await click(q('[data-testid="connect-tab-lending"]'));
    await settle(6);
    expect(q('[data-testid="connect-tab-lending"]')!.getAttribute('aria-selected')).toBe('true');
    expect(q('[data-testid="connect-panel-lending"]')!.hasAttribute('hidden')).toBe(false);
    expect(q('[data-testid="connect-panel-devices"]')!.hasAttribute('hidden')).toBe(true);
    expect(rememberedConnectTab()).toBe('lending');
    await click(q('[data-testid="connect-tab-team"]'));
    await settle(6);
    expect(rememberedConnectTab()).toBe('team');
  });

  it('a tab keeps its half-done sheet and its scroll place while another tab is open', async () => {
    const scroller = document.createElement('div');
    scroller.className = 'ck-connect-scroll';
    document.body.appendChild(scroller);
    root = createRoot(scroller);
    await act(async () => root!.render(<Screen api={makeApi({ phones: [PHONE] })} />));
    await settle(10);
    scroller.scrollTop = 120;
    await click(q('[data-testid="connect-add-phone"]'));
    expect(q('[data-testid="connect-add-phone-sheet"]')).not.toBeNull();
    await click(q('[data-testid="connect-tab-team"]'));
    await settle(6);
    expect(scroller.scrollTop).toBe(0);
    scroller.scrollTop = 40;
    await click(q('[data-testid="connect-tab-devices"]'));
    await settle(6);
    expect(scroller.scrollTop).toBe(120);
    expect(q('[data-testid="connect-add-phone-sheet"]')).not.toBeNull();
    await click(q('[data-testid="connect-tab-team"]'));
    await settle(6);
    expect(scroller.scrollTop).toBe(40);
    scroller.remove();
  });

  it('arrow keys move between the tabs', async () => {
    await mountScreen(makeApi());
    const key = (k: string) =>
      act(async () => {
        q('[data-testid="connect-tab-devices"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
      });
    await key('ArrowRight');
    expect(q('[data-testid="connect-tab-team"]')!.getAttribute('aria-selected')).toBe('true');
  });

  it('a tab that needs you gets an amber dot: this PC cannot be reached, someone asks to borrow', async () => {
    const lend = createFakeLendApi(lendState({ grants: [], requests_in: [{ id: 'r1', from: 'Sam', from_name: 'Sam', agent: 'claude', state: 'open' } as never] }));
    await h.mount(makeApi({ tunnel: fakeTunnel(stable('failed')).api, lend }));
    expect(q('[data-testid="connect-dot-devices"]')).not.toBeNull();
    expect(q('[data-testid="connect-dot-lending"]')).not.toBeNull();
    expect(q('[data-testid="connect-dot-team"]')).toBeNull();
  });
});

describe('Connect > Devices', () => {
  it('brand new: This PC first with one button, the giant code in the middle, an empty PC list', async () => {
    await h.mount(makeApi());
    const sections = [...document.querySelectorAll('[data-testid="connect-panel-devices"] section')].map((s) => s.getAttribute('data-testid'));
    expect(sections).toEqual(['connect-relay', 'connect-phone-group', 'connect-pc-group', 'connect-ssh-group']);
    expect(q('[data-testid="connect-relay"]')!.getAttribute('data-state')).toBe('none');
    expect(text('[data-testid="relay-set-up"]')).toBe('Make it work anywhere');
    expect(text('[data-testid="connect-this-name"]')).toBe('REN-DESK');
    const hero = q('[data-testid="connect-phone-hero"]')!;
    expect(hero).not.toBeNull();
    expect(hero.querySelector('canvas[data-testid="connect-qr"]')).not.toBeNull();
    expect(hero.querySelector('.cn-simple--giant')).not.toBeNull();
    expect(q('[data-testid="connect-add-phone"]')).toBeNull();
    expect(q('[data-testid="connect-pc-empty"]')).not.toBeNull();
    expect(q('[data-testid="connect-add-pc"]')).not.toBeNull();
  });

  it('working: Works anywhere with the link and Copy; a phone row and PC rows in their own groups', async () => {
    const devices = new DevicesFake({ enabled: true, name: 'REN-DESK', devices: [MAC_MINI, WORK_LAPTOP] });
    await h.mount(makeApi({ tunnel: fakeTunnel(stable('linked')).api, phones: [PHONE], devices }));
    expect(q('[data-testid="connect-relay"]')!.getAttribute('data-state')).toBe('working');
    expect(text('[data-testid="connect-relay-status"]')).toBe('Works anywhere');
    expect(text('[data-testid="connect-relay-host"]')).toBe('pm-relay.maya.workers.dev');
    expect(text('[data-testid="relay-menu-copy"]')).toBe('Copy');
    const phone = q('[data-testid="connect-phone-group"]')!;
    const pcs = q('[data-testid="connect-pc-group"]')!;
    expect(phone.textContent).toContain("Ren's iPhone");
    expect(phone.textContent).toContain('Can watch, answer and send messages');
    expect(q('[data-testid="connect-phone-hero"]')).toBeNull();
    expect(q('[data-testid="connect-add-phone"]')).not.toBeNull();
    expect(pcs.textContent).toContain('Mac mini');
    expect(pcs.textContent).toContain('Work laptop');
    expect(pcs.textContent).not.toContain("Ren's iPhone");
    expect(phone.textContent).not.toContain('Mac mini');
    // Phone and PC words never mix, and nothing is shared between the two groups.
    expect(phone.textContent).not.toMatch(/Can work on this PC|Open/);
    expect(phone.querySelector('[data-testid="connect-add-pc"]')).toBeNull();
    expect(pcs.querySelector('[data-testid="connect-add-phone"]')).toBeNull();
  });

  it('broken: one sentence and Fix it on This PC, the phone and the PCs say they are waiting', async () => {
    const devices = new DevicesFake({ enabled: true, name: 'REN-DESK', devices: [MAC_MINI] });
    await h.mount(makeApi({ tunnel: fakeTunnel(stable('failed')).api, phones: [PHONE], devices }));
    expect(q('[data-testid="connect-relay"]')!.getAttribute('data-state')).toBe('broken');
    expect(text('[data-testid="connect-relay-problem-text"]')).toBe("Your phone and other PCs can't reach this PC.");
    expect(text('[data-testid="connect-relay-fix"]')).toBe('Fix it');
    expect(text('[data-testid="connect-phone-group"]')).toContain('Waiting for this PC');
    expect(text('[data-testid="connect-pc-group"]')).toContain('Waiting for this PC');
  });

  it('Open on a PC calls the sidebar hook; without a hook it shows that PC\'s own page with a Back button', async () => {
    const devices = new DevicesFake({ enabled: true, name: 'REN-DESK', devices: [MAC_MINI] });
    const opened: string[] = [];
    await h.mount(makeApi({ tunnel: fakeTunnel(stable('linked')).api, devices }), 'devices', { onOpenPc: (n) => opened.push(n) });
    await click(q(`[data-testid="connect-pc-open-${MAC_MINI.node}"]`));
    expect(opened).toEqual([MAC_MINI.node]);
    await h.remount(makeApi({ tunnel: fakeTunnel(stable('linked')).api, devices }));
    await click(q(`[data-testid="connect-pc-open-${MAC_MINI.node}"]`));
    await settle(4);
    expect(q('[data-testid="connect-device-page"]')).not.toBeNull();
    expect(q('[data-testid="device-route"]')).toBeNull();
    await click(q('[data-testid="device-back"]'));
    expect(q('[data-testid="connect-pc-group"]')).not.toBeNull();
  });

  it('PCs on the same account list themselves; one still needs Allow there; the tick row is a plain switch', async () => {
    const account = fakeAccount({
      pcs: [
        { id: 'a', name: 'REN-LAPTOP', status: 'online', online: true, last_seen_at: Math.floor(Date.now() / 1000), created_at: 1, recent: false, node: MAC_MINI.node },
        { id: 'b', name: 'REN-WORK', status: 'allow_there', online: true, last_seen_at: Math.floor(Date.now() / 1000), created_at: 1, recent: false, node: null },
      ],
    });
    const devices = new DevicesFake({ enabled: true, name: 'REN-DESK', devices: [MAC_MINI] });
    await h.mount(makeApi({ tunnel: fakeTunnel(stable('linked')).api, devices, account }));
    expect(text('[data-testid="account-pc-a"]')).toContain('REN-LAPTOP');
    expect(q('[data-testid="account-pc-open-a"]')).not.toBeNull();
    expect(text('[data-testid="account-pc-line-b"]')).toBe('PC · Online. Press Allow on REN-WORK first.');
    expect(q('[data-testid="account-pc-open-b"]')).toBeNull();
    expect(q('[data-testid="account-pcs-tick"]')!.getAttribute('role')).toBe('switch');
    // The same PC is not listed twice (it is in the account list, so the plain paired list leaves it out).
    expect(document.querySelectorAll(`[data-testid="device-${MAC_MINI.node}"]`)).toHaveLength(0);
  });
});

describe('Connect > Team and Lending', () => {
  it('Team shows today\'s page, and the thin reach line only while this PC cannot be reached', async () => {
    await mountScreen(makeApi({ tunnel: fakeTunnel(stable('linked')).api, team: fakeTeam(true) }), 'team');
    expect(q('[data-testid="connect-reach"]')).toBeNull();
    expect(pageText()).not.toMatch(NO_FOLDS);
    await mountScreen(makeApi({ tunnel: fakeTunnel(stable('failed')).api, team: fakeTeam(true) }), 'team');
    const line = [...document.querySelectorAll('[data-testid="connect-reach"]')].pop()!;
    // The line says the true reason (here the plain one: a restart can still help), not a generic sentence.
    expect(line.textContent).toContain("Your phone and other PCs can't reach this PC.");
    expect(line.textContent).toContain('Fix it');
  });

  it('Team brand new (no team) shows the start-a-team page', async () => {
    await h.mount(makeApi({ team: fakeTeam(false, { joins: [] }) }), 'team');
    expect(pageText().length).toBeGreaterThan(40);
    expect(q('[data-testid="connect-reach"]')).toBeNull();
  });

  it('Lending off: one switch that turns it on; on: Ask to borrow and the rules page', async () => {
    const api = makeApi({ settings: { lend_enabled: false }, lend: createFakeLendApi({ enabled: false }) });
    await h.mount(api, 'lending');
    const sw = q<HTMLInputElement>('[data-testid="connect-lending-switch"]')!;
    expect(sw.checked).toBe(false);
    // Borrowing needs no setup, so Ask to borrow shows with the switch off too.
    expect(q('[data-testid="connect-main-lending"]')).not.toBeNull();
    expect(q('.lend-page')).toBeNull();
    await click(sw);
    await settle(8);
    expect(api.patches).toContainEqual({ lend_enabled: true });
    expect(q('[data-testid="connect-main-lending"]')).not.toBeNull();
  });

  it('Lending working: counts what is lent, and shows the reach line when this PC is broken', async () => {
    const lend = createFakeLendApi(lendState({ grants: [GRANT_OUT] }));
    await h.mount(makeApi({ lend, tunnel: fakeTunnel(stable('failed')).api }), 'lending');
    expect(text('[data-testid="connect-status-lending"]')).toContain('Lending 1');
    expect(q('[data-testid="connect-reach"]')).not.toBeNull();
    expect(q('[data-testid="connect-main-lending"]')).not.toBeNull();
  });
});

describe('Connect > plain words on every screen', () => {
  const states: { name: string; api: () => Partial<ConnectApi>; tab: ConnectTab }[] = [
    { name: 'devices brand new', api: () => makeApi(), tab: 'devices' },
    { name: 'devices working', api: () => makeApi({ tunnel: fakeTunnel(stable('linked')).api, phones: [PHONE], devices: new DevicesFake({ enabled: true, name: 'REN-DESK', devices: [MAC_MINI] }) }), tab: 'devices' },
    { name: 'devices broken', api: () => makeApi({ tunnel: fakeTunnel(stable('failed')).api, phones: [PHONE] }), tab: 'devices' },
    { name: 'devices starting', api: () => makeApi({ tunnel: fakeTunnel(stable('linking')).api }), tab: 'devices' },
    { name: 'devices off', api: () => makeApi({ settings: { devices_enabled: false } }), tab: 'devices' },
    { name: 'team brand new', api: () => makeApi({ team: fakeTeam(false) }), tab: 'team' },
    { name: 'team working', api: () => makeApi({ team: fakeTeam(true), tunnel: fakeTunnel(stable('linked')).api }), tab: 'team' },
    { name: 'team broken', api: () => makeApi({ team: fakeTeam(true), tunnel: fakeTunnel(stable('failed')).api }), tab: 'team' },
    { name: 'lending off', api: () => makeApi({ settings: { lend_enabled: false }, lend: createFakeLendApi({ enabled: false }) }), tab: 'lending' },
    { name: 'lending working', api: () => makeApi({ lend: createFakeLendApi(lendState({ grants: [GRANT_OUT] })) }), tab: 'lending' },
    { name: 'lending broken', api: () => makeApi({ tunnel: fakeTunnel(stable('failed')).api }), tab: 'lending' },
  ];
  for (const s of states) {
    it(`${s.name}: no relay / Worker / tunnel / port / node / pairing / pm: / domain words, no Advanced, More options or Technical details`, async () => {
      await h.mount(s.api(), s.tab);
      const shown = pageText();
      expect(shown.length).toBeGreaterThan(20);
      expect(shown).not.toContain('Getting ready');
      const bad = shown.replace(/pm-relay\.maya\.workers\.dev/g, '').match(FORBIDDEN);
      expect(bad, `found "${bad?.[0]}" in: ${shown}`).toBeNull();
      expect(shown).not.toMatch(NO_FOLDS);
      expect(q('details')).toBeNull();
    });
  }

  it('the sheets are plain too: add a phone, add a PC with its link made, a phone, a PC', async () => {
    const devices = new DevicesFake({ enabled: true, name: 'REN-DESK', devices: [MAC_MINI] });
    await h.mount(makeApi({ tunnel: fakeTunnel(stable('linked')).api, phones: [PHONE], devices }));
    const check = () => {
      const shown = text('.cx-sheet').replace(/pm-relay\.maya\.workers\.dev/g, '');
      expect(shown.length).toBeGreaterThan(10);
      expect(shown, shown).not.toMatch(FORBIDDEN);
      expect(shown).not.toMatch(NO_FOLDS);
    };
    await click(q('[data-testid="connect-add-phone"]'));
    check();
    await click(q('.cx-sheet button[aria-label="Close"]'));
    await click(q('.cx-namebtn'));
    check();
    await click(q('.cx-sheet button[aria-label="Close"]'));
    await click(q('[data-testid="connect-add-pc"]'));
    check();
    await click(q('[data-testid="connect-pc-make-link"]'));
    await settle(6);
    expect(q('[data-testid="connect-pc-link"]')).not.toBeNull();
    check();
    await click(q('.cx-sheet button[aria-label="Close"]'));
    await click(q(`[data-testid="connect-pc-name-${MAC_MINI.node}"]`));
    check();
  });

  it('speaks Traditional Chinese on all three tabs', async () => {
    setLanguagePref('zh-TW', false);
    await mountScreen(makeApi({ tunnel: fakeTunnel(quick()).api }));
    expect(pageText()).toContain('裝置');
    expect(pageText()).toContain('我的手機');
    expect(pageText()).toContain('讓它隨處可用');
    expect(pageText()).not.toMatch(NO_FOLDS);
  });
});

describe('Connect > plain words: the setup sheet, the six-digit sheets and Traditional Chinese', () => {
  const NOW = Math.floor(Date.now() / 1000);
  const plain = (shown: string) => {
    const bad = shown.replace(/pm-relay\.maya\.workers\.dev/g, '').match(FORBIDDEN);
    expect(bad, `found "${bad?.[0]}" in: ${shown}`).toBeNull();
    expect(shown).not.toMatch(NO_FOLDS);
  };
  const failing = { step: async () => ({ ok: false, output: 'boom' }), check: async () => ({ reachable: true, features: [], legacyLink: false }), pauseMs: 0 } as never;
  const untilProblem = async () => {
    for (let i = 0; i < 80 && !q('[data-testid="relay-problem"]'); i++) await act(async () => void (await new Promise((r) => setTimeout(r, 25))));
  };
  let stop: (a: { ok: boolean; output: string }) => void = () => undefined;
  const waiting = { step: () => new Promise((r) => (stop = r as typeof stop)), cancel: () => stop({ ok: false, output: 'Cancelled.' }), check: async () => ({ reachable: true, features: [], legacyLink: false }), pauseMs: 0 } as never;

  it('the setup sheet while it runs and after it fails', async () => {
    await h.mount({ ...makeApi({ tunnel: fakeTunnel(quick()).api }), updateApi: waiting });
    await click(q('[data-testid="relay-set-up"]'));
    await settle(6);
    plain(text('[data-testid="relay-sheet"]'));
    await click(q('[data-testid="relay-cancel"]'));
    await settle(10);
    await h.remount({ ...makeApi({ tunnel: fakeTunnel(quick()).api }), updateApi: failing });
    await click(q('[data-testid="relay-set-up"]'));
    await untilProblem();
    expect(q('[data-testid="relay-problem"]'), text('[data-testid="relay-sheet"]')).not.toBeNull();
    plain(text('[data-testid="relay-sheet"]'));
  });

  it.each([
    ['type', { id: 7, role: 'host', name: 'REN-LAPTOP', code: '', expires_at: NOW + 300, mode: 'type', account: { first_seen: NOW - 86400 * 30 } }],
    ['show', { id: 8, role: 'joiner', name: 'REN-LAPTOP', code: '', expires_at: NOW + 300, mode: 'show', number: '482915', account: { first_seen: NOW - 86400 * 30 } }],
    ['check', { id: 9, role: 'host', name: 'REN-LAPTOP', code: '', expires_at: NOW + 300, mode: 'check', choices: ['111111', '222222', '333333'], fingerprint: 'A1B2 C3D4' }],
  ])('the %s sheet has no technical words and the digits box shows dashes', async (_mode, pending) => {
    const d = new DevicesFake({ enabled: true, name: 'REN-DESK', devices: [MAC_MINI], pending: pending as never });
    await h.mount(makeApi({ tunnel: fakeTunnel(stable('linked')).api, devices: d }));
    const sheet = text('[data-testid="pair-confirm"]');
    expect(sheet.length).toBeGreaterThan(20);
    plain(sheet);
    expect(sheet).not.toMatch(/tapped for you|\d{4}-\d{2}-\d{2}/);
    const input = q<HTMLInputElement>('[data-testid="pair-type"]');
    if (input) expect(input.placeholder).toBe('--- ---');
  });

  it('Traditional Chinese: every state of all three tabs, the sheets and the digit sheet show no technical English word', async () => {
    setLanguagePref('zh-TW', false);
    const cases: [Partial<ConnectApi>, ConnectTab][] = [
      [makeApi({ tunnel: fakeTunnel(quick()).api }), 'devices'],
      [makeApi({ tunnel: fakeTunnel(stable('linked')).api, phones: [PHONE], devices: new DevicesFake({ enabled: true, name: 'REN-DESK', devices: [MAC_MINI] }) }), 'devices'],
      [makeApi({ tunnel: fakeTunnel(stable('failed')).api, phones: [PHONE] }), 'devices'],
      [makeApi({ team: fakeTeam(true), tunnel: fakeTunnel(stable('failed')).api }), 'team'],
      [makeApi({ tunnel: fakeTunnel(stable('failed')).api, lend: createFakeLendApi(lendState({ grants: [GRANT_OUT] })) }), 'lending'],
      [makeApi({ tunnel: fakeTunnel(stable('linked')).api, devices: new DevicesFake({ enabled: true, name: 'REN-DESK', devices: [MAC_MINI], pending: { id: 7, role: 'host', name: 'REN-LAPTOP', code: '', expires_at: NOW + 300, mode: 'type', account: { first_seen: NOW - 86400 * 30 } } as never }) }), 'devices'],
    ];
    for (const [api, tab] of cases) {
      await h.remount(api, tab);
      plain(pageText() + text('[data-testid="pair-confirm"]'));
    }
    await h.remount({ ...makeApi({ tunnel: fakeTunnel(quick()).api }), updateApi: failing });
    await click(q('[data-testid="relay-set-up"]'));
    await untilProblem();
    plain(text('[data-testid="relay-sheet"]'));
  });
});
