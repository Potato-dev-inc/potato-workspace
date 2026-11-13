// @vitest-environment jsdom
// The peek card on a sidebar agent row: hover about 400 ms or Space on a focused row; it shows what the agent does,
// has Open to the side and Stop, answers a low-risk question, closes on leave and Esc, and never takes focus.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneInfo } from '@potato-workspace/shared';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { TurnSummary } from '../../lib/cockpit-api';
import { publishPlanProgress } from '../../lib/planProgress';
import { LS_SIDEBAR_PROJECTS } from '../../lib/sidebarProjects';
import type { GitState, ShipApi } from '../../lib/ship-api';
import { LastTurnContext } from './away-context';
import { Sidebar } from './Sidebar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView ??= () => {};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  localStorage.setItem(LS_SIDEBAR_PROJECTS, JSON.stringify([{ path: 'C:\\work\\shop' }]));
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  publishPlanProgress('a', null);
  vi.useRealTimers();
});

const turn: TurnSummary = {
  paneId: 'a',
  agent: 'codex',
  turn: 2,
  startedAtMs: 0,
  endedAtMs: 1,
  durationMs: 1,
  files: { count: 3, added: 5, deleted: 1, paths: ['x', 'y', 'z'] },
  approvals: [],
  end: { kind: 'idle' },
  sentence: 'Fixed the cart total.',
};

function fakeApi(extra: Partial<CockpitApi> = {}): CockpitApi {
  const mk = (id: string, status: string, cwd: string) => ({
    info: { id, agent_type: 'codex', pid: 1, status, created_at: 1, last_output_at: null, cwd, cols: 80, rows: 24, title: null } as unknown as PaneInfo,
    status,
  });
  const panes = [mk('a', 'running', 'C:\\work\\shop'), mk('b', 'waiting_input', 'C:\\work\\shop')];
  return {
    registry: { paneList: panes, panes: new Map(panes.map((p) => [p.info.id, p])), initialReady: true },
    names: new Map([
      ['a', 'Alpha'],
      ['b', 'Beta'],
    ]),
    activities: { a: { kind: 'working', text: 'Editing cart.tsx' } },
    asked: { questions: [] },
    launchEntries: [{ type: 'codex', label: 'Codex', icon: null }],
    readyAgents: new Set<string>(['codex']),
    mode: 'orchestration',
    theme: 'dark',
    selectedId: null,
    select: vi.fn(),
    interrupt: vi.fn(async () => {}),
    answer: vi.fn(async () => {}),
    setMode: vi.fn(async () => {}),
    newAgent: vi.fn(async () => null),
    prompts: {
      b: {
        promptId: 'q1',
        kind: 'approval',
        text: 'Run npm test?',
        choices: [
          { id: 'y', label: 'Yes' },
          { id: 'n', label: 'No' },
        ],
        risk: { level: 'low', headline: 'Safe', reasons: [] },
      },
    },
    statusSince: new Map([['a', 60_000 - 125_000 + 300_000]]),
    now: 300_000 + 60_000,
    spawn: null,
    toasts: [],
    notify: vi.fn(),
    bridgeLine: '',
    ...extra,
  } as unknown as CockpitApi;
}

const ship = { recent: vi.fn(async () => []), gitState: vi.fn(async () => 'repo' as unknown as GitState), gitInitPlan: vi.fn(), gitInit: vi.fn(), forget: vi.fn(), pickFolder: vi.fn() } as unknown as ShipApi;

async function render(c: CockpitApi = fakeApi(), props: Partial<React.ComponentProps<typeof Sidebar>> = {}) {
  await act(async () =>
    root.render(
      <LastTurnContext.Provider value={new Map([['a', turn]])}>
        <Sidebar c={c} onOpenPalette={() => {}} ship={ship} {...props} />
      </LastTurnContext.Provider>,
    ),
  );
  await act(async () => {});
}
const wrap = (id: string) => host.querySelector<HTMLElement>(`[data-pane-row="${id}"]`)!.closest<HTMLElement>('.ck-rowwrap')!;
const card = () => host.querySelector<HTMLElement>('[data-testid="peek-card"]');
const hover = (id: string) => act(async () => wrap(id).dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
const enter = (el: HTMLElement) => el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
const leave = (el: HTMLElement) => el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
const wait = (ms: number) => act(async () => void vi.advanceTimersByTime(ms));

describe('the peek card on a sidebar row', () => {
  it('opens after the pointer rests about 400 ms, not before', async () => {
    await render();
    await act(async () => enter(wrap('a')));
    await wait(300);
    expect(card()).toBeNull();
    await wait(150);
    expect(card()).not.toBeNull();
  });

  it('says what the agent is doing: step, time running, files, last line', async () => {
    await render();
    await act(async () => enter(wrap('a')));
    await wait(450);
    const text = card()!.textContent!;
    expect(text).toContain('Alpha');
    expect(text).toContain('Editing cart.tsx');
    expect(text).toContain('2m');
    expect(text).toContain('3 files changed');
    expect(text).toContain('Fixed the cart total.');
    expect(card()!.getAttribute('aria-label')).toBe('Quick look at Alpha');
  });

  it('shows how far its plan has come', async () => {
    publishPlanProgress('a', { done: 2, total: 5, current: 'Write tests', allDone: false });
    await render();
    await act(async () => enter(wrap('a')));
    await wait(450);
    expect(card()!.textContent).toContain('2 of 5 steps done');
    expect(card()!.querySelector('[role="progressbar"]')).not.toBeNull();
  });

  it('closes when the pointer leaves (after a short grace)', async () => {
    await render();
    await act(async () => enter(wrap('a')));
    await wait(450);
    await act(async () => leave(wrap('a')));
    await wait(100);
    expect(card()).not.toBeNull();
    await wait(200);
    expect(card()).toBeNull();
  });

  it('stays open while the pointer is on the card', async () => {
    await render();
    await act(async () => enter(wrap('a')));
    await wait(450);
    await act(async () => card()!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body })));
    await act(async () => leave(wrap('a')));
    await wait(1000);
    expect(card()).not.toBeNull();
  });

  it('Stop interrupts the running agent; Open to the side asks for the split', async () => {
    const c = fakeApi();
    const onOpenToSide = vi.fn();
    await render(c, { onOpenToSide });
    await act(async () => enter(wrap('a')));
    await wait(450);
    const button = (name: string) => [...card()!.querySelectorAll('button')].find((b) => b.textContent === name)!;
    await act(async () => button('Open to the side').click());
    expect(onOpenToSide).toHaveBeenCalledWith('a');
    expect(card()).toBeNull();
    await act(async () => enter(wrap('a')));
    await wait(450);
    await act(async () => button('Stop').click());
    expect(c.interrupt).toHaveBeenCalledWith('a');
  });

  it('Space on a focused row opens it without moving focus; Space again or Esc closes it', async () => {
    await render();
    const row = host.querySelector<HTMLButtonElement>('[data-pane-row="a"]')!;
    row.focus();
    const space = (type: 'keydown' | 'keyup') => new KeyboardEvent(type, { key: ' ', bubbles: true, cancelable: true });
    let down!: KeyboardEvent;
    await act(async () => {
      down = space('keydown');
      row.dispatchEvent(down);
      row.dispatchEvent(space('keyup'));
    });
    expect(down.defaultPrevented).toBe(true);
    expect(card()).not.toBeNull();
    expect(document.activeElement).toBe(row);
    expect(row.getAttribute('aria-current')).toBeNull();
    await act(async () => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(card()).toBeNull();
    await act(async () => void row.dispatchEvent(space('keydown')));
    expect(card()).not.toBeNull();
    await act(async () => void row.dispatchEvent(space('keydown')));
    expect(card()).toBeNull();
  });

  it('a waiting agent shows its question with Yes / No when it is low risk', async () => {
    const c = fakeApi();
    await render(c);
    await act(async () => enter(wrap('b')));
    await wait(450);
    expect(card()!.textContent).toContain('Waiting for you');
    expect(card()!.textContent).toContain('Run npm test?');
    const yes = [...card()!.querySelectorAll('button')].find((b) => b.textContent === 'Yes')!;
    await act(async () => yes.click());
    expect(c.answer).toHaveBeenCalledWith('b', 'q1', 'y', 'Yes', expect.anything());
    expect(card()).toBeNull();
  });

  it('a question that is not low risk only offers to open the chat', async () => {
    const c = fakeApi({
      prompts: { b: { promptId: 'q2', kind: 'approval', text: 'Delete the folder?', choices: [{ id: 'y', label: 'Yes' }, { id: 'n', label: 'No' }], risk: { level: 'high', headline: 'Deletes files', reasons: [] } } },
    } as Partial<CockpitApi>);
    await render(c);
    await act(async () => enter(wrap('b')));
    await wait(450);
    const labels = [...card()!.querySelectorAll('button')].map((b) => b.textContent);
    expect(labels).toContain('Open to answer');
    expect(labels).not.toContain('Yes');
    await act(async () => [...card()!.querySelectorAll('button')].find((b) => b.textContent === 'Open to answer')!.click());
    expect(c.select).toHaveBeenCalledWith('b');
  });

  it('a click on the row closes the card', async () => {
    await render();
    await act(async () => enter(wrap('a')));
    await wait(450);
    await act(async () => void host.querySelector('[data-pane-row="a"]')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(card()).toBeNull();
  });

  it('has no animation when less motion is asked for', () => {
    const css = readFileSync(join(__dirname, '../../styles/cockpit-peek.css'), 'utf8');
    expect(css).toMatch(/prefers-reduced-motion: reduce\)[\s\S]*animation: none/);
  });
});
