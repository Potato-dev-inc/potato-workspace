// @vitest-environment jsdom
// 1.1.8 Inbox upgrades, through the real Inbox screen: a stuck helper is ONE card with Nudge / Stop / Respawn (merged with
// the loop-guard card, counted once), and "Working now" lists who is working without ever adding to "Needs you".
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneInfo } from '@potato-workspace/shared';
import type { CockpitApi } from '../../hooks/useCockpit';
import { LoopGuardContext, type LoopSignal } from '../../lib/loop-guard';
import { setStalls } from '../../lib/stalls';
import { Inbox } from './Inbox';

vi.mock('../../lib/collision', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/collision')>()),
  tauriCollisionApi: { list: () => Promise.resolve([]), ignore: vi.fn(), settingsGet: vi.fn(), settingsSet: vi.fn(), onChanged: () => Promise.resolve(() => {}) },
}));
const stallApi = vi.hoisted(() => ({ nudge: vi.fn(() => Promise.resolve()), stop: vi.fn(() => Promise.resolve()), respawn: vi.fn(() => Promise.resolve()) }));
vi.mock('../../lib/stalls', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../lib/stalls')>()), tauriStallApi: stallApi }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (Element.prototype as { scrollIntoView?: () => void }).scrollIntoView = () => {};
  window.localStorage.setItem('pm.cockpit.everSpawned', '1');
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  Object.values(stallApi).forEach((f) => f.mockClear());
});
afterEach(() => {
  act(() => root.unmount());
  act(() => setStalls(new Map()));
  host.remove();
  window.localStorage.clear();
});

const NOW = 3_600_000;
const info = (id: string, status: string): PaneInfo =>
  ({ id, agent_type: 'claude', pid: 1, status, created_at: 1, last_output_at: null, cwd: 'C:\\work\\shop', cols: 80, rows: 24, title: null }) as unknown as PaneInfo;

function cockpit(statuses: Record<string, string>, activities: Record<string, string> = {}) {
  const list = Object.entries(statuses).map(([id, status]) => ({ info: info(id, status), status }));
  const select = vi.fn();
  const interrupt = vi.fn();
  const api = {
    registry: { paneList: list, panes: new Map(list.map((p) => [p.info.id, p])), initialReady: true },
    names: new Map(list.map((p) => [p.info.id, `Helper ${p.info.id}`])),
    asked: { questions: [], answerQuestion: vi.fn(), dismissQuestion: vi.fn() },
    activities: Object.fromEntries(Object.entries(activities).map(([id, text]) => [id, { kind: 'working', text }])),
    launchEntries: [],
    readyAgents: new Set<string>(),
    mode: 'orchestration',
    theme: 'dark',
    selectedId: null,
    select,
    prompts: {},
    statusSince: new Map(list.map((p, i) => [p.info.id, NOW - (i + 1) * 120_000] as const)),
    now: NOW,
    interrupt,
    newAgent: vi.fn(),
  } as unknown as CockpitApi;
  return { api, select, interrupt };
}

const signal: LoopSignal = { pane_id: 'a', kind: 'repeated_error', evidence_lines: ['npm ERR! one'], turns: 4, since: 1, summary: 'the same error 4 times' };
const mount = (api: CockpitApi, signals: Record<string, LoopSignal> = {}) =>
  act(() =>
    root.render(
      <LoopGuardContext.Provider value={{ signals, dismiss: () => {} }}>
        <Inbox c={api} />
      </LoopGuardContext.Provider>,
    ),
  );
const button = (label: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent === label) as HTMLButtonElement | undefined;
const count = () => host.querySelector('.ck-inbox-count')?.textContent;

describe('stuck helpers in the Inbox', () => {
  it('a helper with no progress is one card with Nudge, Stop and Respawn, and it counts once', async () => {
    const { api } = cockpit({ a: 'running' });
    mount(api);
    expect(host.querySelector('[data-kind="stuck"]')).toBeNull();
    act(() => setStalls(new Map([['a', 6]])));
    const cards = host.querySelectorAll('[data-kind="stuck"]');
    expect(cards.length).toBe(1);
    expect(cards[0].textContent).toContain('Agent Helper a has made no progress for 6 min.');
    expect(count()).toBe('1');
    expect(Array.from(cards[0].querySelectorAll('button')).map((b) => b.textContent)).toEqual(['Nudge', 'Stop', 'Respawn']);
    await act(async () => button('Nudge')!.click());
    expect(stallApi.nudge).toHaveBeenCalledWith('a');
    expect(host.textContent).toContain('Asked it to say what it is doing.');
    await act(async () => button('Stop')!.click());
    expect(stallApi.stop).toHaveBeenCalledWith('a');
    await act(async () => button('Respawn')!.click());
    expect(stallApi.respawn).toHaveBeenCalledWith('a');
  });

  it('the loop-guard card and the stall are ONE card for the same helper', () => {
    const { api } = cockpit({ a: 'running' });
    act(() => setStalls(new Map([['a', 9]])));
    mount(api, { a: signal });
    expect(host.querySelectorAll('[data-kind="stuck"]').length).toBe(1);
    expect(count()).toBe('1');
    const card = host.querySelector('[data-kind="stuck"]')!;
    expect(card.textContent).toContain('seems stuck: the same error 4 times');
    expect(card.textContent).toContain('No progress for 9 min.');
    expect(card.textContent).toContain('npm ERR! one');
    const labels = Array.from(card.querySelectorAll('button')).map((b) => b.textContent);
    expect(labels).toEqual(expect.arrayContaining(['Nudge', 'Stop', 'Respawn']));
  });

  it('a loop signal alone keeps its old buttons', () => {
    const { api } = cockpit({ a: 'running' });
    mount(api, { a: signal });
    expect(Array.from(host.querySelectorAll('[data-kind="stuck"] button')).map((b) => b.textContent)).toEqual(['Give it a hint', 'Interrupt', 'Ask another agent', 'Dismiss']);
  });
});

describe('Working now', () => {
  it('lists the working chats with their step and time, and never counts toward Needs you', () => {
    const { api, select, interrupt } = cockpit({ a: 'running', b: 'running', c: 'idle' }, { a: 'Running npm test' });
    mount(api);
    const sec = host.querySelector('[data-testid="working-now"]')!;
    expect(sec.querySelector('h2')!.textContent).toContain('Working now');
    const rows = sec.querySelectorAll('[data-working-row]');
    expect(rows.length).toBe(2);
    // longest first: b has run 4 min, a 2 min
    expect((rows[0] as HTMLElement).dataset.workingRow).toBe('b');
    expect(rows[1].textContent).toContain('Running npm test');
    expect(rows[1].textContent).toContain('2m');
    expect(count()).toBeUndefined();
    expect(host.querySelector('[data-testid="inbox-clear"]')).not.toBeNull();
    act(() => (rows[1].querySelector('button[aria-label="Stop Helper a"]') as HTMLButtonElement).click());
    expect(interrupt).toHaveBeenCalledWith('a');
    act(() => (rows[1].querySelector('button[aria-label="Open chat: Helper a"]') as HTMLButtonElement).click());
    expect(select).toHaveBeenCalledWith('a');
  });

  it('shows five rows, then Show all', () => {
    const statuses = Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => [id, 'running']));
    const { api } = cockpit(statuses);
    mount(api);
    expect(host.querySelectorAll('[data-working-row]').length).toBe(5);
    act(() => button('Show all 7')!.click());
    expect(host.querySelectorAll('[data-working-row]').length).toBe(7);
    act(() => button('Show fewer')!.click());
    expect(host.querySelectorAll('[data-working-row]').length).toBe(5);
  });

  it('leaves out a helper that has its own stuck card, and is silent when nobody works', () => {
    const { api } = cockpit({ a: 'running', b: 'running' });
    act(() => setStalls(new Map([['a', 6]])));
    mount(api);
    expect(Array.from(host.querySelectorAll('[data-working-row]')).map((r) => (r as HTMLElement).dataset.workingRow)).toEqual(['b']);
    act(() => setStalls(new Map()));
    const idle = cockpit({ a: 'idle' });
    mount(idle.api);
    expect(host.querySelector('[data-testid="working-now"]')).toBeNull();
  });
});
