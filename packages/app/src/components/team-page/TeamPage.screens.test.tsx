// @vitest-environment jsdom
// The Team page as whole screens: TeamHost with mock team and lend APIs (only the desktop shell is faked). Each tab is reached
// by clicking its tab; the privacy defaults, Take back, Lend, join approval and the empty state are proven here.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GRANT_IN, GRANT_OUT, LendBackend, REQUEST_MAYA, type LendScenario } from '../../dev/lend-fixtures';
import { teamConfig, teamState } from '../../dev/team-fixtures';
import type { LendApi } from '../../lib/lend';
import type { PresenceView, ShareView, TeamApi, TeamConfigView, TeamState } from '../../lib/team';
import { resetRememberedTab } from './TeamPage';
import { TeamHost } from './TeamHost';

vi.mock('qrcode', () => ({ default: { toCanvas: vi.fn(async () => undefined) } }));
vi.mock('../../lib/openSettingsAt', () => ({ openSettingsAt: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  resetRememberedTab();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const NOW = Date.now();
const pres = (member: string, over: Partial<PresenceView> = {}): PresenceView => ({ member, state: 'here', atMs: NOW - 5_000, sinceMs: NOW - 60_000, project: null, title: null, running: 0, waiting: 0, ...over });

function teamFake(over: { state?: Partial<TeamState>; config?: Partial<TeamConfigView> } = {}) {
  const calls: string[] = [];
  let share: ShareView | undefined = over.state?.share;
  const rec = <T,>(name: string, value: () => T) => async (...args: unknown[]) => {
    calls.push(`${name}(${args.map((a) => JSON.stringify(a)).join(',')})`);
    return value();
  };
  const api = {
    calls,
    state: async () => teamState({ presence: [], ...over.state, share }),
    configGet: async () => teamConfig(over.config),
    defaultName: async () => 'Leo',
    approveJoin: rec('approveJoin', () => teamConfig()),
    declineJoin: rec('declineJoin', () => teamConfig()),
    create: rec('create', () => teamConfig()),
    join: rec('join', () => teamConfig()),
    leave: rec('leave', () => teamConfig()),
    clearGaps: rec('clearGaps', () => undefined),
    shareSet: async (level: ShareView['level'], exclude: string[]) => {
      calls.push(`shareSet(${level},${JSON.stringify(exclude)})`);
      share = { level, exclude };
      return share;
    },
    onChanged: async () => () => {},
    onDraft: async () => () => {},
  } as unknown as TeamApi & { calls: string[] };
  return api;
}

function lendFake(seed: LendScenario | null) {
  const b = new LendBackend(seed ?? { enabled: false });
  if (!seed) b.state = { ...b.state, enabled: false };
  const api = {
    state: async () => b.get(),
    revoke: async (id: string) => b.revoke(id),
    giveBack: async (id: string) => b.giveBack(id),
    answer: async (id: string, accept: boolean, profileId: string | null, secs: number | null) => b.answer(id, accept, profileId, secs),
    offers: async () => ({ answered: false, offers: [] }),
    onChanged: async (cb: () => void) => b.on(cb),
  } as unknown as LendApi;
  return { b, api };
}

async function show(team: TeamApi, lend: LendApi) {
  await act(async () => root.render(<TeamHost api={team} lendClient={lend} />));
  await act(async () => {});
  await act(async () => {});
}
const tab = (id: string) => host.querySelector<HTMLButtonElement>(`[data-testid="tab-${id}"]`)!;
const open = async (id: string) => {
  await act(async () => tab(id).click());
  await act(async () => {});
};
const btn = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text);
const click = async (text: string) => {
  const b = btn(text);
  if (!b) throw new Error(`no button "${text}"`);
  await act(async () => b.click());
  await act(async () => {});
};

describe('Team page: header and People', () => {
  it('shows the team name, link words, counts, the six tabs and every person with a word beside the dot', async () => {
    const team = teamFake({ state: { presence: [pres('m-maya', { project: 'potato-workspace', title: 'Fix the sheet', running: 2 }), pres('m-sam', { state: 'away', sinceMs: NOW - 12 * 60_000 })] } });
    await show(team, lendFake(null).api);
    const text = host.textContent ?? '';
    expect(text).toContain('Acme');
    expect(text).toContain('Connected');
    expect(text).toContain('3 people · 2 here now');
    for (const name of ['People', 'Usage', 'Tasks', 'Shelf', 'Feed', 'Setup']) expect(tab(name.toLowerCase()).textContent).toContain(name);
    const people = [...host.querySelectorAll('.tpg-person')].map((el) => el.getAttribute('data-testid'));
    expect(people).toEqual(['person-m-leo', 'person-m-maya', 'person-m-sam']);
    expect(host.querySelector('[data-testid="person-m-maya"]')!.textContent).toContain('Working on potato-workspace · "Fix the sheet"');
    expect(host.querySelector('[data-testid="person-m-maya"]')!.textContent).toContain('2 agents running');
    expect(host.querySelector('[data-testid="person-m-sam"]')!.textContent).toContain('Away · 12 min');
    // Each state has a word, never colour alone.
    for (const el of host.querySelectorAll('.tpg-presence')) expect((el.textContent ?? '').trim().length).toBeGreaterThan(0);
  });

  it('privacy: a person who shares nothing but "here" has no project or chat-title line', async () => {
    await show(teamFake({ state: { presence: [pres('m-maya'), pres('m-sam')] } }), lendFake(null).api);
    expect(host.textContent).not.toContain('Working on');
    expect(host.querySelector('[data-testid="person-m-maya"]')!.textContent).toContain('Here');
  });

  it('privacy: my own line says others see no project and no chat title, and the sheet opens on "That I am here"', async () => {
    const team = teamFake();
    await show(team, lendFake(null).api);
    expect(host.querySelector('[data-testid="others-see"]')!.textContent).toContain('No project, no chat title');
    await click('Change');
    const checked = host.querySelector<HTMLInputElement>('input[name="team-share-level"]:checked')!;
    expect(checked.value).toBe('here');
    expect(checked.parentElement!.textContent).toContain('That I am here');
    // The foot note and the exclusion list are there.
    expect(host.textContent).toContain('Titles are cleaned of keys and paths before they are sent.');
    expect(host.textContent).toContain('Not for these projects:');
  });

  it('turning on the project and title is a deliberate choice, saved through shareSet', async () => {
    const team = teamFake();
    await show(team, lendFake(null).api);
    await click('Change');
    const radio = host.querySelector<HTMLInputElement>('input[name="team-share-level"][value="title"]')!;
    await act(async () => radio.click());
    const area = host.querySelector<HTMLTextAreaElement>('textarea')!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      set.call(area, 'D:\\secret-project\n');
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click('Save');
    expect(team.calls).toContain('shareSet(title,["D:\\\\secret-project"])');
    expect(host.querySelector('[data-testid="share-sheet"]')).toBeNull();
    expect(host.querySelector('[data-testid="others-see"]')!.textContent).toContain("the chat's title");
  });

  it('an admin lets a join request in or says no', async () => {
    const team = teamFake();
    await show(team, lendFake(null).api);
    expect(host.textContent).toContain("Priya wants to join from Priya's MacBook.");
    expect(tab('people').textContent).toContain('1');
    await click('Let in');
    expect(team.calls).toContain('approveJoin("j-priya")');
    await click('No');
    expect(team.calls).toContain('declineJoin("j-priya")');
  });

  it('a person who is not an admin sees no join requests and no Invite button', async () => {
    await show(teamFake({ config: { admin: false } }), lendFake(null).api);
    expect(host.textContent).not.toContain('wants to join');
    expect(host.querySelector('[data-testid="team-invite"]')).toBeNull();
  });
});

describe('Team page: Usage', () => {
  it('shows the promise, a lend out and a borrow with time left, and Take back asks first and then revokes', async () => {
    const lend = lendFake({ grants: [GRANT_OUT, GRANT_IN], requests_in: [] });
    await show(teamFake(), lend.api);
    await open('usage');
    expect(host.textContent).toContain("A sign-in never leaves its PC. A lend runs through the lender's PC and ends on time.");
    expect(host.querySelector(`[data-testid="grant-${GRANT_OUT.id}"]`)!.textContent).toContain('Maya');
    expect(host.querySelector(`[data-testid="grant-${GRANT_OUT.id}"]`)!.textContent).toContain('left');
    expect(host.querySelector(`[data-testid="grant-${GRANT_IN.id}"]`)).not.toBeNull();
    await click('Take back');
    expect(lend.b.calls.some((c) => c.startsWith('revoke'))).toBe(false);
    const confirm = [...host.querySelectorAll<HTMLButtonElement>('.lend-confirm button')].find((b) => b.textContent === 'Take back')!;
    await act(async () => confirm.click());
    await act(async () => {});
    expect(lend.b.calls.some((c) => c.startsWith(`revoke(${JSON.stringify(GRANT_OUT.id)}`))).toBe(true);
  });

  it('Give back on a borrow calls giveBack', async () => {
    const lend = lendFake({ grants: [GRANT_IN] });
    await show(teamFake(), lend.api);
    await open('usage');
    await click('Give back');
    expect(lend.b.calls.some((c) => c.startsWith('giveBack'))).toBe(true);
  });

  it('a request waits under "Waiting for you" and Lend answers it', async () => {
    const lend = lendFake({ requests_in: [REQUEST_MAYA] });
    await show(teamFake(), lend.api);
    expect(tab('usage').textContent).toContain('1');
    await open('usage');
    expect(host.textContent).toContain('Waiting for you');
    expect(host.textContent).toContain('Mine hit its limit');
    const tick = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((i) => i.parentElement?.textContent?.includes('I understand'))!;
    await act(async () => tick.click());
    await click('Lend');
    expect(lend.b.calls.some((c) => c.startsWith('answer(') && c.includes('true'))).toBe(true);
  });

  it('Request usage lives here (the button is on the Usage tab)', async () => {
    await show(teamFake(), lendFake({}).api);
    await open('usage');
    expect([...host.querySelectorAll('button')].some((b) => /request usage|ask for usage/i.test(b.textContent ?? ''))).toBe(true);
  });

  it('with lending off the tab is one card, and no sign-in words leak', async () => {
    await show(teamFake(), lendFake(null).api);
    await open('usage');
    expect(host.querySelector('[data-testid="usage-off"]')!.textContent).toContain('Lending is off.');
    expect(host.textContent).not.toMatch(/token|password|api key/i);
  });
});

describe('Team page: Tasks, Shelf, Feed, Setup', () => {
  it('Tasks lists review requests and notes from teammates as plain text, and says so when empty', async () => {
    const event = { ...teamState().cards[0].event, id: '01JA0REVIEW00000000000009', kind: 'please_review' as const, note: '<img src=x onerror=alert(1)> please look', actor: { member: 'm-maya', device: 'd', display: 'Maya' } };
    const card = { ...teamState().cards[0], id: event.id, event };
    await show(teamFake({ state: { cards: [card] } }), lendFake(null).api);
    expect(tab('tasks').textContent).toContain('1');
    await open('tasks');
    expect(host.textContent).toContain('For you');
    expect(host.textContent).toContain('<img src=x onerror=alert(1)> please look');
    expect(host.querySelector('img')).toBeNull();
  });

  it('Tasks empty state', async () => {
    await show(teamFake({ state: { cards: [] } }), lendFake(null).api);
    await open('tasks');
    expect(host.querySelector('[data-testid="tasks-empty"]')!.textContent).toContain('Nothing passed around yet');
  });

  it('Shelf says one quiet line when the backend cannot answer (older build, no desktop shell)', async () => {
    await show(teamFake(), lendFake(null).api);
    await open('shelf');
    expect(host.querySelector('[data-testid="shelf-unavailable"]')!.textContent).toContain('not available');
  });

  it('Feed shows the cards, day separators and filters', async () => {
    await show(teamFake(), lendFake(null).api);
    await open('feed');
    expect(host.textContent).toContain('Today');
    expect(host.textContent).toContain('feat/auth');
    await click('PRs');
    expect(host.textContent).not.toContain('feat/auth pushed');
    expect(btn('PRs')!.getAttribute('aria-pressed')).toBe('true');
    await click('CI');
    expect(host.querySelector('[data-testid="feed-empty"]')).not.toBeNull();
  });

  it('Setup re-hosts the Settings team block (people and roles, leave)', async () => {
    await show(teamFake(), lendFake(null).api);
    await open('setup');
    expect(host.querySelector('[data-testid="setup-tab"]')).not.toBeNull();
    expect(host.textContent).toContain('Acme');
  });

  it('Invite opens Setup through the stub slot', async () => {
    await show(teamFake(), lendFake(null).api);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="team-invite"]')!.click());
    expect(tab('setup').getAttribute('aria-selected')).toBe('true');
  });

  const withInvite = (team: TeamApi, invite: () => Promise<unknown>) => ({ ...team, invite }) as unknown as TeamApi;

  it('Invite makes the one-time Worker link and shows it, with Copy and a new one', async () => {
    let n = 0;
    const team = withInvite(teamFake(), async () => ({ link: 'pm://old', code: 'AAAA-BBBB', expiresAtMs: NOW + 86_400_000, joinUrl: `https://pm-relay.acme.workers.dev/join/code${++n}` }));
    const write = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true });
    await show(team, lendFake(null).api);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="team-invite"]')!.click());
    await act(async () => {});
    const sheet = host.querySelector('[data-testid="invite-sheet"]');
    expect(sheet).not.toBeNull();
    expect(tab('setup').getAttribute('aria-selected')).not.toBe('true');
    expect(host.querySelector<HTMLInputElement>('[data-testid="invite-sheet-link"]')!.value).toBe('https://pm-relay.acme.workers.dev/join/code1');
    expect(sheet!.textContent).toContain('It works once, for 24 hours.');
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="invite-sheet-copy"]')!.click());
    expect(write).toHaveBeenCalledWith('https://pm-relay.acme.workers.dev/join/code1');
    await click('New invite');
    expect(host.querySelector<HTMLInputElement>('[data-testid="invite-sheet-link"]')!.value).toBe('https://pm-relay.acme.workers.dev/join/code2');
    await click('Close');
    expect(host.querySelector('[data-testid="invite-sheet"]')).toBeNull();
  });

  it('Invite falls back to Setup when no Worker is linked (no one-time link) or the link cannot be made', async () => {
    await show(withInvite(teamFake(), async () => ({ link: 'pm://old', code: 'AAAA-BBBB', expiresAtMs: NOW + 1000, joinUrlNote: 'update-worker' })), lendFake(null).api);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="team-invite"]')!.click());
    await act(async () => {});
    expect(host.querySelector('[data-testid="invite-sheet"]')).toBeNull();
    expect(tab('setup').getAttribute('aria-selected')).toBe('true');
    resetRememberedTab();
    await act(async () => root.render(<div />));
    await show(withInvite(teamFake(), async () => Promise.reject(new Error('no relay'))), lendFake(null).api);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="team-invite"]')!.click());
    await act(async () => {});
    expect(tab('setup').getAttribute('aria-selected')).toBe('true');
  });

  it('remembers the tab for the session', async () => {
    await show(teamFake(), lendFake(null).api);
    await open('shelf');
    await act(async () => root.render(<div />));
    await show(teamFake(), lendFake(null).api);
    expect(tab('shelf').getAttribute('aria-selected')).toBe('true');
  });
});

describe('Team page: no team yet', () => {
  it('shows the two ways in, and Start a team opens the existing form', async () => {
    const team = teamFake({ config: { team: '', members: [], joins: [] } });
    await show(team, lendFake(null).api);
    expect(host.querySelector('[data-testid="team-empty"]')!.textContent).toContain('Work with your team');
    expect(btn('I have an invite')).toBeDefined();
    await click('Start a team');
    expect(host.querySelector('.tp-form')).not.toBeNull();
  });

  it('I have an invite opens the join form', async () => {
    await show(teamFake({ config: { team: '', members: [], joins: [] } }), lendFake(null).api);
    await click('I have an invite');
    expect(host.querySelector('.tp-form')).not.toBeNull();
  });
});
