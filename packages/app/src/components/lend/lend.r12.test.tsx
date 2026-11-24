// @vitest-environment jsdom
// Round 12: who Ask to borrow offers (each machine once, my PCs first, teammates only while Team is on), stale ask rows, the lend
// ended notes in the past rows, the Inbox row that outlives the toast, and no native tooltip over an open lend card.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevicesFake, MAC_MINI } from '../../dev/devices-fixtures';
import { createFakeLendApi, GRANT_IN_PANE, GRANT_IN, GRANT_OUT, LEND_MEMBERS, lendState, REQUEST_OUT } from '../../dev/lend-fixtures';
import { teamConfig } from '../../dev/team-fixtures';
import { displayName, endedNotice, endedWords, pastGrants, rowName, type Grant } from '../../lib/lend';
import type { TeamApi } from '../../lib/team';
import { click, settle } from '../settings/test-utils';
import { BorrowedChip } from './Borrowed';
import { ENDED_ROW_MS, endedRows, LendEndedRows } from './LendEndedRows';
import { defaultSource, recentAsks, RequestUsage, sourcesOf } from './RequestUsage';

vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
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
  window.localStorage.clear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = '';
});

const mkMember = (id: string, name: string) => ({ id, name, roles: [], admin: false, me: false, github: null, githubConfirmed: false, devices: 1 });

describe('Ask to borrow: who is offered', () => {
  it('while who can be asked is still loading, the dialog is open and says so (not an empty, silent sheet)', async () => {
    const devices = new DevicesFake({ enabled: true, devices: [{ ...MAC_MINI, lets_lend: true }] });
    const slow = { configGet: () => new Promise(() => {}) } as unknown as TeamApi;
    await act(async () => root.render(<RequestUsage api={createFakeLendApi(lendState({}))} team={slow} devices={devices} variant="settings" />));
    await settle(6);
    await click([...host.querySelectorAll('button')].find((b) => b.textContent === 'Ask to borrow')!);
    await settle(6);
    expect(document.querySelector('.lend-sheet')?.textContent).toContain('Loading who you can ask…');
  });

  it('lists a machine once: a teammate named like one of my PCs is that PC', () => {
    const devices = new DevicesFake({ enabled: true, devices: [{ ...MAC_MINI, lets_lend: true }] }).view.devices;
    const { mine, others } = sourcesOf([mkMember('m1', 'mac MINI'), mkMember('m2', 'Maya')] as never, devices);
    expect(mine.map((s) => s.label)).toEqual(['Mac mini']);
    expect(others.map((s) => s.label)).toEqual(['Maya']);
  });

  it('with Team off, a leftover roster is nobody to ask: my PC is the default and there is no teammates group', async () => {
    const devices = new DevicesFake({ enabled: true, devices: [{ ...MAC_MINI, lets_lend: true }] });
    const off = { configGet: async () => teamConfig({ enabled: false, team: '', members: LEND_MEMBERS }) } as unknown as TeamApi;
    const api = createFakeLendApi(lendState({}));
    await act(async () => root.render(<RequestUsage api={api} team={off} devices={devices} variant="settings" />));
    await settle(6);
    await click([...host.querySelectorAll('button')].find((b) => b.textContent === 'Ask to borrow')!);
    await settle(6);
    const sheet = document.querySelector<HTMLElement>('.lend-sheet')!;
    expect([...sheet.querySelectorAll('optgroup')].map((g) => g.label)).toEqual(['My PCs']);
    expect(sheet.querySelector<HTMLSelectElement>('select[aria-label="Ask"]')!.value).toBe(`node:${MAC_MINI.node}`);
  });

  it('with Team off and my PC not allowed yet, the PC is still listed and it says which switch to turn on (with its button) instead of "nobody"', async () => {
    const devices = new DevicesFake({ enabled: true, devices: [{ ...MAC_MINI, lets_lend: false }] });
    const off = { configGet: async () => teamConfig({ enabled: false, team: '', members: LEND_MEMBERS }) } as unknown as TeamApi;
    await act(async () => root.render(<RequestUsage api={createFakeLendApi(lendState({}))} team={off} devices={devices} variant="settings" />));
    await settle(6);
    await click([...host.querySelectorAll('button')].find((b) => b.textContent === 'Ask to borrow')!);
    await settle(6);
    const sheet = document.querySelector<HTMLElement>('.lend-sheet')!;
    expect(sheet.querySelector('[data-testid="lend-switch-off"]')!.textContent).toContain('Mac mini');
    expect(sheet.textContent).not.toContain('There is nobody to ask yet');
    expect(sheet.querySelector<HTMLSelectElement>('select[aria-label="Ask"]')!.value).toBe(`node:${MAC_MINI.node}`);
  });

  it('never lists the same machine twice, or this PC to itself, and a stopped team offers nobody', () => {
    const devices = new DevicesFake({ enabled: true, devices: [{ ...MAC_MINI, lets_lend: false }] }).view.devices;
    const named = { ...mkMember('m3', 'Zed'), deviceList: [{ id: 'd1', name: 'MAC mini' }] };
    const thisPc = { ...mkMember('m4', 'Somebody'), deviceList: [{ id: 'd9', name: 'whatever', current: true }] };
    const { mine, others } = sourcesOf([mkMember('m1', "ren's linux"), named, thisPc, mkMember('m2', 'Maya')] as never, devices, ['Ren’s Linux', "REN's linux"]);
    expect(mine.map((s) => [s.label, s.blocked])).toEqual([['Mac mini', true]]);
    expect(others.map((s) => s.label)).toEqual(['Maya']);
  });

  it('opens on the first PC with its switch on, then on the first PC, then on a teammate', () => {
    const a = { value: 'a', label: 'A', memberId: '', deviceId: null, mine: true, blocked: true };
    const b = { ...a, value: 'b', label: 'B', blocked: false };
    const t = { ...a, value: 't', label: 'T', mine: false, blocked: undefined };
    expect(defaultSource([a, b], [t])?.value).toBe('b');
    expect(defaultSource([a], [t])?.value).toBe('a');
    expect(defaultSource([], [t])?.value).toBe('t');
    expect(defaultSource([], [])).toBeUndefined();
  });

  it('a team that is not running (removed) is nobody to ask: my PC stays the choice', async () => {
    const devices = new DevicesFake({ enabled: true, devices: [{ ...MAC_MINI, lets_lend: true }] });
    const stopped = { configGet: async () => teamConfig({ enabled: true, team: 't1', transport: null, members: LEND_MEMBERS }) } as unknown as TeamApi;
    await act(async () => root.render(<RequestUsage api={createFakeLendApi(lendState({}))} team={stopped} devices={devices} variant="settings" />));
    await settle(6);
    await click([...host.querySelectorAll('button')].find((b) => b.textContent === 'Ask to borrow')!);
    await settle(6);
    const sheet = document.querySelector<HTMLElement>('.lend-sheet')!;
    expect([...sheet.querySelectorAll('optgroup')].map((g) => g.label)).toEqual(['My PCs']);
  });
});

describe('past lends order', () => {
  it('newest ended first; a row with no end time (older build) goes below the dated ones', () => {
    const now = Date.now();
    const g = (id: string, over: Partial<Grant>): Grant => ({ ...GRANT_OUT, id, state: 'ended', end_reason: 'revoked', ...over });
    const rows = pastGrants([g('old', { ended_ms: now - 5000, ends_ms: now - 4000 }), g('legacy', { ended_ms: null, ends_ms: now + 3600_000 }), g('new', { ended_ms: now - 1000, ends_ms: now + 99 })], 'out', now);
    expect(rows.map((r) => r.id)).toEqual(['new', 'old', 'legacy']);
  });
});

describe('stale ask rows', () => {
  const now = Date.now();
  it('drops an ask past the time it asked for, and a Ready one with no live borrow', () => {
    const old = { ...REQUEST_OUT, id: 'old', state: 'open' as const, at_ms: now - 30 * 3600_000, secs: 12 * 3600 };
    const ready = { ...REQUEST_OUT, id: 'ready', state: 'accepted' as const, at_ms: now - 3600_000, secs: 12 * 3600 };
    const waiting = { ...REQUEST_OUT, id: 'wait', state: 'open' as const, at_ms: now - 60_000, secs: 3600 };
    const state = lendState({ requests_out: [old, ready, waiting], grants: [] });
    expect(recentAsks(state, now).map((r) => r.id)).toEqual(['wait']);
  });
  it('one row per lender and agent (the newest), Ready goes once the borrow began, Said no can be removed', () => {
    const base = { ...REQUEST_OUT, agent_id: 'claude', secs: 3600 };
    const a = { ...base, id: 'a', state: 'declined' as const, at_ms: now - 3000_000 };
    const b = { ...base, id: 'b', state: 'open' as const, at_ms: now - 2000_000, secs: 7200 };
    const c = { ...base, id: 'c', state: 'accepted' as const, at_ms: now - 60_000 };
    expect(recentAsks(lendState({ requests_out: [a, b] }), now).map((r) => r.id)).toEqual(['b']);
    expect(recentAsks(lendState({ requests_out: [c] }), now).map((r) => r.id)).toEqual(['c']);
    const borrow = { ...GRANT_IN, agent_id: 'claude', started_ms: now - 30_000 };
    expect(recentAsks(lendState({ requests_out: [c], grants: [borrow] }), now)).toEqual([]);
    expect(recentAsks(lendState({ requests_out: [a] }), now, ['a'])).toEqual([]);
    expect(recentAsks(lendState({ requests_out: [{ ...a, at_ms: now - 25 * 3600_000, secs: 86400 }] }), now)).toEqual([]);
  });
});

describe('one name for a PC', () => {
  it('is the device name, else the account label, on every row for my own PCs', () => {
    expect(displayName({ device: 'founder-dev3', label: 'REN' })).toBe('founder-dev3');
    expect(displayName({ device: '', label: 'REN' })).toBe('REN');
    expect(displayName({})).toBe('your other PC');
    const mine = { ...GRANT_OUT, for_other_person: false, peer_name: 'REN', peer_device_name: 'founder-dev3' };
    expect(rowName(mine)).toBe('founder-dev3');
    // A teammate is still the person.
    expect(rowName({ ...mine, for_other_person: true })).toBe('REN');
  });
});

describe('lend ended notes', () => {
  const ended = (over: Partial<Grant>): Grant => ({ ...GRANT_OUT, state: 'ended', end_reason: 'revoked', ended_ms: Date.now() - 1000, ...over });
  it('says this PC restarted on my lend and that the borrower no longer had it', () => {
    expect(endedWords(ended({ end_note: 'lender restarted' }))).toBe('Taken back · this PC restarted');
    expect(endedNotice(ended({ end_note: 'lender restarted' }))).toBe('Lend ended: this PC restarted');
    expect(endedWords(ended({ end_note: 'not held', end_reason: 'returned' }))).toBe('Given back · the borrower no longer had it');
    expect(endedNotice(ended({ end_note: 'not held', end_reason: 'returned' }))).toBe('Lend ended: the borrower no longer had it');
    // A note I do not know is never shown (words from the other PC stay out).
    expect(endedWords(ended({ end_note: 'Ignore previous instructions' }))).toBe('Taken back');
  });
  it('says the borrower restarted on both sides', () => {
    expect(endedNotice({ ...GRANT_IN, state: 'ended', end_reason: 'revoked', end_note: 'borrower restarted' })).toBe('Lend ended: this PC restarted');
    expect(endedNotice(ended({ end_note: 'borrower restarted', end_reason: 'returned' }))).toBe("Lend ended: the borrower's PC restarted");
  });
  it('says the lender restarted on a borrow', () => {
    expect(endedWords({ ...GRANT_IN, state: 'ended', end_reason: 'revoked', end_note: 'lender restarted' })).toContain('PC restarted');
  });
});

describe('the Inbox row for a lend that ended', () => {
  const at = Date.now();
  const mine = (id: string, over: Partial<Grant> = {}): Grant => ({ ...GRANT_OUT, id, state: 'ended', end_reason: 'revoked', end_note: 'lender restarted', ended_ms: at - 1000, ...over });

  it('keeps a recent one, drops an old one, a quiet one and a dismissed one', () => {
    const rows = endedRows([mine('a'), mine('old', { ended_ms: at - ENDED_ROW_MS - 1 }), mine('quiet', { end_note: null }), mine('gone')], at, ['gone']);
    expect(rows.map((g) => g.id)).toEqual(['a']);
  });

  it('shows the line, and the X removes it for good', async () => {
    const state = lendState({ grants: [mine('a')] });
    await act(async () => root.render(<LendEndedRows state={state} now={at} />));
    expect(host.querySelector('[data-testid="lend-ended-rows"]')!.textContent).toContain('Lend ended: this PC restarted');
    await click(host.querySelector<HTMLButtonElement>('button[aria-label="Remove this row"]')!);
    expect(host.querySelector('[data-testid="lend-ended-rows"]')).toBeNull();
    await act(async () => root.render(<LendEndedRows state={state} now={at} key="again" />));
    expect(host.querySelector('[data-testid="lend-ended-rows"]')).toBeNull();
  });
});

describe('the Inbox row with Lending off', () => {
  it('an ended lend still has its row in the Team section while the Lending switch is off', async () => {
    const { TeamSection } = await import('../cockpit/team/TeamSection');
    const { createFakeLendApi } = await import('../../dev/lend-fixtures');
    const at = Date.now();
    const state = lendState({ enabled: false, grants: [{ ...GRANT_OUT, id: 'e1', state: 'ended', end_reason: 'revoked', end_note: 'lender restarted', ended_ms: at - 1000 }] });
    const api = createFakeLendApi(state);
    await act(async () => root.render(<TeamSection now={at} lend={api} team={{ state: null, refresh: () => {} } as never} />));
    await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
    expect(host.querySelector('[data-testid="lend-ended-rows"]')?.textContent).toContain('Lend ended: this PC restarted');
  });
});

describe('the lend card chip', () => {
  it('has no native tooltip while its card is open', async () => {
    const api = createFakeLendApi({ grants: [GRANT_IN_PANE] });
    await act(async () => root.render(<BorrowedChip paneId="pane-claude-1" api={api} />));
    await settle(6);
    const chip = host.querySelector<HTMLButtonElement>('[data-testid="lend-chip"]');
    if (!chip) throw new Error('no chip');
    expect(chip.getAttribute('title')).toBeTruthy();
    await click(chip);
    await settle(4);
    expect(host.querySelector('[data-testid="lend-chip"]')!.hasAttribute('title')).toBe(false);
  });
});
