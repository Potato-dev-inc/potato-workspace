// @vitest-environment jsdom
// The Inbox page (1.1.1): one calm line when nothing needs you, "Done today", "Team activity", no Request usage.
// Rendered through the real Inbox, with the turn summaries and the team state a cockpit would hold.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneInfo } from '@potato-workspace/shared';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { TurnSummary } from '../../lib/cockpit-api';
import type { Question } from '../../lib/questions';
import { MAYA_PUSH, SAM_PR, teamState } from '../../dev/team-fixtures';
import { DONE_CLEARED_KEY, dayKey, doneToday } from '../../lib/done-today';
import { ACTIVITY_MAX, toneOf } from '../../lib/inbox-activity';
import { registerSettingsOpener } from '../../lib/openSettingsAt';
import { LastTurnContext } from './away-context';
import { Inbox } from './Inbox';

const team = vi.hoisted(() => ({ state: null as unknown }));
vi.mock('../../lib/team', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/team')>();
  return {
    ...real,
    teamApi: { ...real.teamApi, state: () => (team.state ? Promise.resolve(team.state) : Promise.reject(new Error('no team'))), onChanged: () => Promise.resolve(() => {}) },
  };
});
vi.mock('../../lib/collision', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/collision')>()),
  tauriCollisionApi: { list: () => Promise.resolve([]), ignore: vi.fn(), settingsGet: vi.fn(), settingsSet: vi.fn(), onChanged: () => Promise.resolve(() => {}) },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 14:30 local on a fixed day, so "since midnight" and the clock times do not depend on when the test runs.
const NOW = new Date(2026, 10, 16, 14, 30, 0).getTime();
const at = (h: number, m: number, day = 16) => new Date(2026, 10, day, h, m, 0).getTime();

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (Element.prototype as { scrollIntoView?: () => void }).scrollIntoView = () => {};
  window.localStorage.setItem('pm.cockpit.everSpawned', '1');
  team.state = null;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  window.localStorage.clear();
  registerSettingsOpener(null);
});

const info = (id: string, agent: string, status: string): PaneInfo =>
  ({ id, agent_type: agent, pid: 1, status, created_at: 1, last_output_at: null, cwd: 'C:\\work\\shop', cols: 80, rows: 24, title: null }) as unknown as PaneInfo;

function api(questions: Question[] = []): { c: CockpitApi; select: ReturnType<typeof vi.fn> } {
  const spec = [info('p1', 'claude', 'idle'), info('p2', 'codex', 'idle'), info('p3', 'opencode', 'idle')];
  const list = spec.map((i) => ({ info: i, status: i.status }));
  const select = vi.fn();
  const c = {
    registry: { paneList: list, panes: new Map(list.map((p) => [p.info.id, p])), initialReady: true },
    names: new Map([['p1', 'Right panel rebuild'], ['p2', 'Word viewer pages'], ['p3', 'Inbox empty state']]),
    asked: { questions, answerQuestion: vi.fn(), dismissQuestion: vi.fn() },
    launchEntries: [],
    readyAgents: new Set<string>(),
    mode: 'orchestration',
    theme: 'dark',
    selectedId: null,
    select,
    prompts: {},
    statusSince: new Map(),
    now: NOW,
    spawn: null,
    answer: vi.fn(),
    interrupt: vi.fn(),
    newAgent: vi.fn(),
  } as unknown as CockpitApi;
  return { c, select };
}

const turn = (paneId: string, agent: string, endedAtMs: number, files: { count: number; added: number; deleted: number } | null, extra: Partial<TurnSummary> = {}): TurnSummary => ({
  paneId,
  agent,
  turn: 1,
  startedAtMs: endedAtMs - 60_000,
  endedAtMs,
  durationMs: 60_000,
  files: files ? { ...files, paths: [] } : null,
  approvals: [],
  end: { kind: 'idle' },
  sentence: 'Done.',
  ...extra,
});

const TURNS = new Map<string, TurnSummary>([
  ['p1', turn('p1', 'claude', at(14, 2), { count: 12, added: 1204, deleted: 998 }, { receipt: { checks: '2 of 2 checks pass', outcome: 'ok' } })],
  ['p2', turn('p2', 'gemini', at(11, 40), { count: 3, added: 310, deleted: 42 })],
  ['p3', turn('p3', 'opencode', at(10, 15), null)],
  ['old', turn('old', 'codex', at(23, 50, 15), { count: 1, added: 1, deleted: 0 })],
]);

const mount = (c: CockpitApi, turns: ReadonlyMap<string, TurnSummary> = new Map()) =>
  act(() =>
    root.render(
      <LastTurnContext.Provider value={turns}>
        <Inbox c={c} />
      </LastTurnContext.Provider>,
    ),
  );
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

describe('Inbox page: nothing needs you', () => {
  it('is one compact status line at the top, with no Request usage anywhere', async () => {
    mount(api().c);
    await flush();
    const strip = host.querySelector('[role="status"].ib-clear');
    expect(strip?.textContent).toContain('Nothing needs you');
    expect(strip?.textContent).toContain('Agents that stop to ask show up here.');
    expect(host.querySelector('h1')?.textContent).toBe('Inbox');
    expect(host.textContent).not.toContain('Request usage');
    // The strip comes before Done today and Team activity (the page does not jump when a card arrives).
    const order = ['.ib-clear', '[data-testid="done-today"]', '[data-testid="team-activity"]'].map((s) => Array.from(host.querySelectorAll('*')).indexOf(host.querySelector(s)!));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((i) => i >= 0)).toBe(true);
  });

  it('swaps the line for the cards when something needs you, and shows the count', async () => {
    const q: Question = { id: 'q1', agent: 'Planner', question: 'Which table style?', choices: [{ id: 'a', label: 'Like Word' }, { id: 'b', label: 'Plain' }], allow_free_text: false, urgency: 'normal', created_at_ms: NOW - 60_000, expires_at_ms: NOW + 600_000, state: 'pending' };
    mount(api([q]).c);
    await flush();
    expect(host.querySelector('.ib-clear')).toBeNull();
    expect(host.querySelector('.ck-inbox-count')?.textContent).toBe('1');
    expect(host.querySelectorAll('[data-ib-card]').length).toBe(1);
    expect(host.querySelector('[data-testid="done-today"]')).not.toBeNull();
  });
});

describe('Inbox page: Done today', () => {
  it('lists only turns since midnight, newest first; Review for changes, Open without', async () => {
    mount(api().c, TURNS);
    await flush();
    const rows = Array.from(host.querySelectorAll<HTMLElement>('[data-done-row]'));
    expect(rows.map((r) => r.dataset.doneRow)).toEqual(['p1', 'p2', 'p3']);
    expect(rows.map((r) => r.dataset.kind)).toEqual(['review', 'review', 'open']);
    expect(rows[0].textContent).toContain('Right panel rebuild');
    expect(rows[0].textContent).toContain('12 files');
    expect(rows[0].textContent).toContain('+1,204');
    expect(rows[0].textContent).toContain('2 of 2 checks pass');
    expect(rows[0].textContent).toContain('14:02');
    expect(rows[0].querySelector('.ib-add')?.textContent).toBe('+1,204');
    expect(rows[0].querySelector('.ib-del')?.textContent).toBe('−998');
    expect(rows[0].querySelector('button')?.textContent).toBe('Review');
    expect(rows[2].textContent).toContain('Answered a question · no changes');
    expect(rows[2].querySelector('button')?.textContent).toBe('Open');
  });

  it('the row button opens that chat', async () => {
    const { c, select } = api();
    mount(c, TURNS);
    await flush();
    act(() => host.querySelector<HTMLButtonElement>('[data-done-row="p2"] button')!.click());
    expect(select).toHaveBeenCalledWith('p2');
  });

  it('says so when nothing finished today', async () => {
    mount(api().c, new Map([['old', TURNS.get('old')!]]));
    await flush();
    expect(host.querySelector('[data-testid="done-today"]')?.textContent).toContain('Nothing finished yet today. Finished work shows up here.');
    expect(host.querySelector('[data-done-row]')).toBeNull();
  });

  it('shows 6, then "Show all"', async () => {
    const many = new Map<string, TurnSummary>();
    for (let i = 0; i < 9; i++) many.set(`m${i}`, turn(`m${i}`, 'claude', at(8, i), null));
    mount(api().c, many);
    await flush();
    expect(host.querySelectorAll('[data-done-row]').length).toBe(6);
    const more = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Show all 9')!;
    act(() => more.click());
    expect(host.querySelectorAll('[data-done-row]').length).toBe(9);
  });

  it('Clear hides today, keeps chats, and stays hidden after a reload; tomorrow starts fresh', async () => {
    mount(api().c, TURNS);
    await flush();
    act(() => Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Clear')!.click());
    expect(host.querySelector('[data-done-row]')).toBeNull();
    expect(window.localStorage.getItem(DONE_CLEARED_KEY)).toBe(dayKey(NOW));
    act(() => root.unmount());
    root = createRoot(host);
    mount(api().c, TURNS);
    await flush();
    expect(host.querySelector('[data-done-row]')).toBeNull();
    // The next day: the mark is for another day, so the list is back.
    window.localStorage.setItem(DONE_CLEARED_KEY, dayKey(NOW - 86_400_000));
    act(() => root.unmount());
    root = createRoot(host);
    mount(api().c, TURNS);
    await flush();
    expect(host.querySelectorAll('[data-done-row]').length).toBe(3);
  });

  it('leaves out a turn that is waiting for an answer, and a future-dated one', () => {
    const waiting = turn('w', 'claude', at(13, 0), null, { end: { kind: 'waiting_input' } });
    const future = turn('f', 'claude', NOW + 3_600_000, null);
    expect(doneToday([waiting, future], NOW)).toEqual([]);
  });
});

describe('Inbox page: Team activity', () => {
  it('has the "No team yet" line and Set up a team when there is no team', async () => {
    mount(api().c);
    await flush();
    const sec = host.querySelector('[data-testid="team-activity"]')!;
    expect(sec.textContent).toContain('No team yet.');
    expect(sec.querySelector('[data-team-activity]')).toBeNull();
    const opened: string[] = [];
    registerSettingsOpener((tab) => opened.push(tab));
    act(() => Array.from(sec.querySelectorAll('button')).find((b) => b.textContent === 'Set up a team')!.click());
    expect(opened).toEqual(['team']);
  });

  it('shows each event with its tone, newest first, five at most', async () => {
    const mk = (id: string, kind: string, ago: number) => ({ id, event: { ...(kind === 'pr_opened' ? SAM_PR : MAYA_PUSH), id, kind }, receivedAtMs: NOW - ago, state: 'new' as const, local: null, panes: [] });
    team.state = teamState({
      cards: [mk('a', 'pr_opened', 5000), mk('b', 'pushed', 4000), mk('c', 'pr_merged', 3000), mk('d', 'note', 2000), mk('e', 'pushed', 1000), mk('f', 'pushed', 9000)],
    });
    mount(api().c);
    await flush();
    const rows = Array.from(host.querySelectorAll<HTMLElement>('[data-team-activity]'));
    expect(rows.length).toBe(ACTIVITY_MAX);
    expect(rows.map((r) => r.dataset.teamActivity)).toEqual(['e', 'd', 'c', 'b', 'a']);
    expect(rows.map((r) => r.querySelector('.ib-tile')?.getAttribute('data-tone'))).toEqual(['push', 'note', 'ok', 'push', 'pr']);
    expect(rows[0].querySelector('.ib-tile--push')).not.toBeNull();
    expect(Array.from(host.querySelectorAll('button')).some((b) => b.textContent === 'Open Team')).toBe(true);
    expect(host.textContent).not.toContain('Request usage');
  });

  it('maps event kinds to the design colours', () => {
    expect(['pr_opened', 'pushed', 'pr_merged', 'ci_failed'].map(toneOf)).toEqual(['pr', 'push', 'ok', 'danger']);
  });
});

describe('Inbox page: rows open their chat', () => {
  const q: Question = { id: 'q1', agent: 'Planner', pane_id: 'p1', question: 'Which table style?', choices: [{ id: 'a', label: 'Like Word' }], allow_free_text: false, urgency: 'normal', created_at_ms: NOW - 60_000, expires_at_ms: NOW + 600_000, state: 'pending' } as Question;

  it('clicking a needs-you card opens its chat; Answer answers in place and does not open it', async () => {
    const { c, select } = api([q]);
    mount(c);
    await flush();
    const answer = host.querySelector<HTMLButtonElement>('[data-ib="answer"]')!;
    act(() => answer.click());
    expect(select).not.toHaveBeenCalled();
    act(() => host.querySelector<HTMLElement>('.ib-title')!.click());
    expect(select).toHaveBeenCalledWith('p1');
  });

  it('Enter on the focused card opens its chat', async () => {
    const { c, select } = api([q]);
    mount(c);
    await flush();
    const card = host.querySelector<HTMLElement>('[data-ib-card]')!;
    act(() => {
      card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    expect(select).toHaveBeenCalledWith('p1');
  });

  it('a Done today row opens on click and Enter, and a closed chat only says so', async () => {
    const { c, select } = api();
    const notify = vi.fn();
    (c as unknown as { notify: unknown }).notify = notify;
    mount(c, new Map([...TURNS, ['gone', turn('gone', 'claude', at(9, 0), null)]]));
    await flush();
    const row = (id: string) => host.querySelector<HTMLElement>(`[data-done-row="${id}"]`)!;
    act(() => row('p2').click());
    expect(select).toHaveBeenLastCalledWith('p2');
    act(() => void row('p3').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    expect(select).toHaveBeenLastCalledWith('p3');
    select.mockClear();
    act(() => row('gone').click());
    expect(select).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith('This chat is closed.');
  });
});
