// @vitest-environment jsdom
// Lend through my PC as whole screens, through the real typed API layers; only the desktop shell (`invoke`) is a mock, and it
// answers the `lend_*`, `accounts_list` and `team_*` commands in the shape the Rust side sends. Proves: Request usage is
// reachable (and sends) in Settings > Team and Inbox > Team; the incoming card renders in the Inbox, counts in Needs you and
// lends / says no; the Lend page is reachable from the nav and from search ("lend", "borrow", "usage") and has no .pm parts;
// a borrowed grant is a sign-in in the New agent menu's picker, with its countdown, next to my own; the pane chip shows time,
// usage and the lender's problem; and with the Labs switch off nothing shows.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneInfo } from '@potato-workspace/shared';
import { borrowedOf, createLendMock, GRANT_IN, GRANT_IN_PANE, GRANT_IN_PROBLEM, GRANT_OUT, lendState, REQUEST_MAYA, type LendScenario } from '../../dev/lend-fixtures';
import type { CockpitApi } from '../../hooks/useCockpit';
import { deriveNeedsYou } from '../../lib/attention';
import type { ShipApi } from '../../lib/ship-api';
import { SettingsPanel, type SettingsApi } from '../SettingsPanel';
import { BASE_SETTINGS, buttonByText, click, settle, type as typeInto } from '../settings/test-utils';
import { TeamPage } from '../settings/blocks/TeamPage';
import { Inbox } from '../cockpit/Inbox';
import { PaneView } from '../cockpit/PaneView';
import { Sidebar } from '../cockpit/Sidebar';

vi.mock('qrcode', () => ({ default: { toCanvas: vi.fn(async () => undefined) } }));
vi.mock('../TerminalViewport', () => ({ TerminalViewport: () => <div data-testid="term" /> }));

const shell = vi.hoisted(() => ({
  lend: null as null | ((cmd: string, a: Record<string, unknown>) => { handled: boolean; value?: unknown }),
  invoked: [] as { cmd: string; args: Record<string, unknown> }[],
  /** What `accounts_list` answers: my own logins and the grants lent to this PC (empty while the switch is off). */
  accounts: { accounts: [] as unknown[], borrowed: [] as unknown[] },
}));
vi.mock('@tauri-apps/api/core', async () => {
  const team = await import('../../dev/team-fixtures');
  const members = (await import('../../dev/lend-fixtures')).LEND_MEMBERS;
  return {
    invoke: vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
      shell.invoked.push({ cmd, args });
      const lend = shell.lend?.(cmd, args);
      if (lend?.handled) return lend.value;
      switch (cmd) {
        case 'team_state':
          return team.teamState({ cards: [] });
        case 'team_config_get':
          return team.teamConfig({ members, joins: [] });
        case 'accounts_list':
          return { agents: [], helper_logins: {}, ...shell.accounts };
        case 'checkpoints_list':
          return { state: 'ok', message: '', items: [] };
        default:
          throw new Error(`not answered in this test: ${cmd}`);
      }
    }),
  };
});
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
  shell.invoked = [];
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  window.localStorage.setItem('pm.cockpit.everSpawned', '1');
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = '';
  window.localStorage.clear();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

const lendIs = (seed: LendScenario | null, own: unknown[] = []) => {
  shell.lend = seed ? createLendMock(seed) : createLendMock({ enabled: false });
  shell.accounts = { accounts: own, borrowed: seed ? borrowedOf(seed.grants ?? []) : [] };
};

// ---- Settings > Team and Inbox > Team ---------------------------------------------------------------------------------

describe('Request usage is reachable from Teams', () => {
  it('Settings > Team: a Request usage button next to the people, and lends on each member row', async () => {
    lendIs(lendState({ grants: [GRANT_OUT, GRANT_IN] }));
    await act(async () => root.render(<TeamPage />));
    await settle(8);
    const people = host.querySelector('[aria-label="People"]')!;
    expect(buttonByText(people.closest('section')!, 'Request usage')).toBeTruthy();
    expect(host.textContent).toMatch(/Lending Claude to Maya · 2h 1\dm left/);
    expect(host.textContent).toMatch(/Borrowing Claude from Sam · 4\dm left/);
    expect(buttonByText(host, 'Revoke')).toBeTruthy();
    expect(buttonByText(host, 'Give back')).toBeTruthy();
    // It opens the sheet, and my other PC comes first.
    await click(buttonByText(host, 'Request usage'));
    await settle(4);
    const sheet = document.querySelector<HTMLElement>('.lend-sheet')!;
    expect([...sheet.querySelectorAll('optgroup')].map((g) => g.label)).toEqual(['My PCs', 'Teammates']);
    // Codex is only a line saying it is coming; Claude is the one to ask for.
    const agents = [...sheet.querySelectorAll<HTMLOptionElement>('select[aria-label="Agent"] option')];
    expect(agents.map((o) => o.textContent)).toEqual(['Claude · Lab', 'Codex: coming soon']);
    expect(agents[1].disabled).toBe(true);
    // Ask works: the command goes out with the member, device, agent and length.
    await click(buttonByText(sheet, 'Ask'));
    await settle(4);
    const ask = shell.invoked.find((i) => i.cmd === 'lend_request')!;
    expect(ask.args).toMatchObject({ member_id: 'm-leo', device_id: 'd-lap', agent_id: 'claude', secs: 28800 });
    expect(document.querySelector('.lend-sheet')!.textContent).toContain('Waiting');
  });

  it('Settings > Team: nothing of it while Share an agent is off', async () => {
    lendIs(null);
    await act(async () => root.render(<TeamPage />));
    await settle(8);
    expect(host.textContent).toContain('People');
    expect(buttonByText(host, 'Request usage')).toBeUndefined();
    expect(host.querySelector('.lend-lends')).toBeNull();
  });

  const inbox = async () => {
    const list = [{ info: { id: 'p1', agent_type: 'claude', pid: 1, status: 'idle', created_at: 1, last_output_at: null, cwd: 'C:\\work\\shop', cols: 80, rows: 24, title: null } as unknown as PaneInfo, status: 'idle' }];
    const c = {
      registry: { paneList: list, panes: new Map(list.map((p) => [p.info.id, p])), initialReady: true },
      names: new Map([['p1', 'Claude']]),
      asked: { questions: [], answerQuestion: vi.fn(), dismissQuestion: vi.fn() },
      launchEntries: [],
      readyAgents: new Set<string>(),
      mode: 'orchestration',
      selectedId: null,
      select: vi.fn(),
      prompts: {},
      statusSince: new Map(),
      now: Date.now(),
      spawn: null,
      newAgent: vi.fn(),
    } as unknown as CockpitApi;
    await act(async () => root.render(<Inbox c={c} />));
    await settle(8);
  };

  it('Inbox > Team: a Request usage button, and a request to borrow shows as a card with the warning', async () => {
    lendIs(lendState({ requests_in: [REQUEST_MAYA] }));
    await inbox();
    const team = host.querySelector('section[aria-label="Team"]')!;
    expect(buttonByText(team, 'Request usage')).toBeTruthy();
    const card = team.querySelector<HTMLElement>('[data-lend-request="req-in-maya"]')!;
    expect(card.textContent).toContain("Maya's laptop wants Claude for 8 hours");
    expect(card.textContent).toContain('Use at your own risk');
    expect(buttonByText(card, 'Lend')!.disabled).toBe(true);
    // A number key never lends.
    expect(card.hasAttribute('data-guard')).toBe(true);
  });

  it('Inbox > Team: the incoming card lends with the profile after "I understand", and Say no declines', async () => {
    lendIs(lendState({ requests_in: [REQUEST_MAYA, { ...REQUEST_MAYA, id: 'req-in-2', reason: 'Another one.' }] }));
    await inbox();
    const team = host.querySelector('section[aria-label="Team"]')!;
    const first = team.querySelector<HTMLElement>('[data-lend-request="req-in-maya"]')!;
    const tick = [...first.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((i) => i.parentElement?.textContent?.includes('I understand'))!;
    await click(tick);
    await click(buttonByText(first, 'Lend'));
    await settle(4);
    const lend = shell.invoked.find((i) => i.cmd === 'lend_answer')!;
    expect(lend.args).toMatchObject({ request_id: 'req-in-maya', accept: true, profile_id: 'prof-team' });
    expect(team.querySelector('[data-lend-request="req-in-maya"]')).toBeNull();
    await click(buttonByText(team.querySelector<HTMLElement>('[data-lend-request="req-in-2"]')!, 'Say no'));
    await settle(4);
    expect(shell.invoked.filter((i) => i.cmd === 'lend_answer').pop()!.args).toMatchObject({ request_id: 'req-in-2', accept: false });
    expect(team.querySelector('[data-lend-request]')).toBeNull();
  });

  it('Inbox > Team: nothing of it while Share an agent is off', async () => {
    lendIs(null);
    await inbox();
    expect(host.querySelector('section[aria-label="Team"]')).not.toBeNull();
    expect(buttonByText(host, 'Request usage')).toBeUndefined();
    expect(host.querySelector('[data-lend-request]')).toBeNull();
  });

  it('a request to borrow counts in Needs you', () => {
    const items = deriveNeedsYou({ panes: [], lendRequests: [{ id: 'req-in-maya', at_ms: 5 }] });
    expect(items).toEqual([{ id: 'lend_request:req-in-maya', kind: 'lend_request', since: 5 }]);
  });
});

// ---- the Lend page: nav and search ------------------------------------------------------------------------------------

describe('Settings > Lend', () => {
  const api = (lend: boolean): SettingsApi => ({
    load: async () => ({ ...BASE_SETTINGS, ...(lend ? { lend_enabled: true } : {}) }),
    patch: async () => ({ ...BASE_SETTINGS }),
    findBridgeUrl: async () => null,
    subscribe: () => () => {},
  });
  const mount = async (lend: boolean, props: Partial<React.ComponentProps<typeof SettingsPanel>> = {}) => {
    lendIs(lend ? lendState() : null);
    await act(async () => root.render(<SettingsPanel open api={api(lend)} {...props} />));
    await settle(6);
  };
  const navTitles = () => [...host.querySelectorAll('.st-nav .st-nav-row')].map((b) => b.textContent);
  const search = () => host.querySelector('input[aria-label="Search settings"]') as HTMLInputElement;
  const main = () => host.querySelector('.st-main') as HTMLElement;

  it('is in the sidebar and opens the page, with its sections', async () => {
    await mount(true);
    expect(navTitles()).toContain('Lend');
    const nav = [...host.querySelectorAll('.st-nav .st-nav-row')].find((b) => b.textContent === 'Lend') as HTMLButtonElement;
    expect(nav.querySelector('svg')).not.toBeNull();
    await click(nav);
    await settle(6);
    // The page itself is loaded when it opens.
    await act(async () => void (await new Promise((r) => setTimeout(r, 100))));
    await settle(4);
    expect(main().querySelector('h1')!.textContent).toBe('Lend');
    for (const label of ['Lend profiles', 'Active lends']) {
      expect(main().querySelector(`section[aria-label="${label}"]`), label).not.toBeNull();
    }
    // The .pm parts are not part of this mode.
    for (const label of ['Save as .pm file', 'Open .pm file']) {
      expect(main().querySelector(`section[aria-label="${label}"]`), label).toBeNull();
    }
    expect(main().textContent).not.toContain('.pm');
    // A basic row: it is not hidden behind "Advanced".
    expect(main().querySelector('[data-row="lend-page"]')).not.toBeNull();
  });

  it.each(['lend', 'borrow', 'usage'])('searching "%s" finds it', async (word) => {
    await mount(true, { initialTab: 'general' });
    await typeInto(search(), word);
    await settle(6);
    expect([...main().querySelectorAll('.st-results > section')].map((s) => s.getAttribute('data-section'))).toContain('lend');
    expect(main().querySelector('[data-row="lend-page"]')).not.toBeNull();
  });

  it.each(['lend', 'borrow', 'usage'])('with the switch off, no nav entry and "%s" finds no Lend page', async (word) => {
    await mount(false, { initialTab: 'general' });
    expect(navTitles()).not.toContain('Lend');
    await typeInto(search(), word);
    await settle(6);
    expect(main().querySelector('[data-row="lend-page"]')).toBeNull();
  });

  it('has the Labs switch in General', async () => {
    await mount(false, { initialTab: 'general' });
    await typeInto(search(), 'share an agent');
    await settle(6);
    expect(main().querySelector('[data-row="lend-labs"]')).not.toBeNull();
    expect(main().querySelector('[data-row="lend-page"]')).toBeNull();
  });
});

// ---- the New agent menu ------------------------------------------------------------------------------------------------

describe('New agent menu: a borrowed grant is a sign-in', () => {
  const ship = {
    recent: vi.fn().mockResolvedValue([{ path: 'C:\\work\\proj', name: 'proj', state: 'repo', last_used_ms: 1 }]),
    gitState: vi.fn().mockResolvedValue('repo'),
  } as unknown as ShipApi;
  const cockpit = () =>
    ({
      registry: { paneList: [], panes: new Map(), initialReady: true },
      names: new Map(),
      asked: { questions: [] },
      launchEntries: [{ type: 'claude', label: 'Claude' }],
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
      newAgent: vi.fn(async () => {}),
      openSettings: vi.fn(async () => {}),
      bridgeLine: '',
    }) as unknown as CockpitApi & { newAgent: ReturnType<typeof vi.fn> };

  const openMenu = async (c: CockpitApi) => {
    await act(async () => root.render(<Sidebar c={c} onOpenPalette={() => {}} ship={ship} />));
    await settle(6);
    await click(host.querySelector('button[aria-label="New agent"]'));
    await settle(6);
    return host.querySelector<HTMLElement>('[role="menu"]')!;
  };
  const items = (menu: HTMLElement) => [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  const claudeRow = (menu: HTMLElement) => items(menu).find((i) => i.textContent?.startsWith('Claude'));

  it('shows "Leo\'s PC (lent) · 1h 5Xm left" in the sign-in step next to my own logins, and starts the pane on it', async () => {
    const own = { id: 'acct-work', agent_id: 'claude', label: 'Work', home: 'C:\\work' };
    // GRANT_IN_PANE has about 2 hours left; the lend I made out is never a sign-in for me.
    lendIs(lendState({ grants: [{ ...GRANT_IN_PANE, pane_ids: [] }, GRANT_OUT] }), [own]);
    const c = cockpit();
    const menu = await openMenu(c);
    // No separate "Borrowed" group: one path, through the sign-in step.
    expect(menu.textContent).not.toContain('Borrowed');
    expect(menu.querySelector('[data-testid^="borrowed-"]')).toBeNull();
    await click(claudeRow(menu));
    await settle(4);
    const step = host.querySelector<HTMLElement>('[role="menu"]')!;
    const labels = items(step).map((i) => i.textContent);
    expect(labels[0]).toBe('Default sign-in');
    expect(labels[1]).toBe('Work');
    expect(labels[2]).toMatch(/^Leo's PC \(lent\) · 1h 5\dm left$/);
    expect(labels).toHaveLength(4); // Default, Work, the borrowed one, Back
    await click(items(step)[2]);
    await settle(4);
    expect(c.newAgent).toHaveBeenCalledTimes(1);
    expect(c.newAgent.mock.calls[0][0]).toBe('claude');
    expect(c.newAgent.mock.calls[0][1]).toBe('lend:grant-in-2');
  });

  it('a lend that is not mine to use (ended, or lent out by me) is not a sign-in; with nothing borrowed, Claude starts at once', async () => {
    lendIs(lendState({ grants: [GRANT_OUT, { ...GRANT_IN, state: 'ended', end_reason: 'revoked' }] }));
    const c = cockpit();
    const menu = await openMenu(c);
    await click(claudeRow(menu));
    await settle(4);
    expect(c.newAgent).toHaveBeenCalledTimes(1);
    expect(c.newAgent.mock.calls[0][1]).toBeUndefined();
  });

  it('with the switch off the backend lists nothing borrowed, and a lend-only login is never a choice', async () => {
    const lendOnly = { id: 'acct-lend', agent_id: 'claude', label: 'Lend login', home: 'C:\\lend', lend_only: true };
    lendIs(null, [lendOnly]);
    const c = cockpit();
    const menu = await openMenu(c);
    await click(claudeRow(menu));
    await settle(4);
    // Only a lend-only login exists: it is not a sign-in for starting, so there is no extra step.
    expect(c.newAgent).toHaveBeenCalledTimes(1);
    expect(host.textContent).not.toContain('lent');
  });
});

// ---- the pane header ---------------------------------------------------------------------------------------------------

describe('Pane header: time-left chip', () => {
  const paneCockpit = (): CockpitApi => {
    const p = { status: 'idle', info: { id: 'pane-claude-1', agent_type: 'claude', status: 'idle', pid: 4120, created_at: 1, last_output_at: null, cwd: 'C:\\work\\shop', cols: 158, rows: 56 } };
    return {
      registry: { paneList: [p], panes: new Map([['pane-claude-1', p]]), initialReady: true },
      names: new Map([['pane-claude-1', 'Claude']]),
      activities: {},
      previews: {},
      asked: { questions: [] },
      prompts: {},
      statusSince: new Map(),
      now: 12_000,
      selectedId: 'pane-claude-1',
      mode: 'orchestration',
      select: vi.fn(),
      notify: vi.fn(),
      answer: vi.fn(),
      closePane: vi.fn(),
    } as unknown as CockpitApi;
  };

  it('shows "Leo\'s Claude" with the time left on a borrowed pane, and Give back now', async () => {
    lendIs(lendState({ grants: [GRANT_IN_PANE] }));
    await act(async () => root.render(<PaneView c={paneCockpit()} paneId="pane-claude-1" />));
    await settle(8);
    const chip = host.querySelector<HTMLButtonElement>('[data-testid="lend-chip"]')!;
    expect(chip.textContent).toMatch(/^Leo's Claude · 1h 5\dm$/);
    await click(chip);
    await click(buttonByText(host, 'Give back now'));
    await settle(4);
    expect(shell.invoked.some((i) => i.cmd === 'lend_return' && i.args.grant_id === 'grant-in-2')).toBe(true);
  });

  it('shows what was used in its details, and the problem of the lender sign-in when there is one', async () => {
    lendIs(lendState({ grants: [GRANT_IN_PROBLEM] }));
    await act(async () => root.render(<PaneView c={paneCockpit()} paneId="pane-claude-1" />));
    await settle(8);
    const chip = host.querySelector<HTMLButtonElement>('[data-testid="lend-chip"]')!;
    expect(chip.dataset.problem).toBe('true');
    await click(chip);
    expect(host.querySelector('[data-testid="lend-usage"]')!.textContent).toBe('Used so far: 3 requests · 5.3k tokens');
    expect(host.querySelector('[data-testid="lend-problem"]')!.textContent).toBe("The lender's sign-in expired. Ask them to sign in again.");
  });

  it('shows no chip while Share an agent is off', async () => {
    lendIs(null);
    await act(async () => root.render(<PaneView c={paneCockpit()} paneId="pane-claude-1" />));
    await settle(8);
    expect(host.querySelector('[data-testid="lend-chip"]')).toBeNull();
  });
});
