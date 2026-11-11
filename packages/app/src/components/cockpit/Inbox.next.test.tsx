// @vitest-environment jsdom
// After a question is answered with a key, the keyboard goes to the next card and a line says whose it is.
// The keys are real KeyboardEvents on the focused element, handled by the Inbox like a person's key press.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneInfo } from '@potato-workspace/shared';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { PanePrompt } from '../../lib/cockpit-api';
import type { Question } from '../../lib/questions';
import { Inbox } from './Inbox';
import { nextKeyAfter, NEXT_HINT_MS } from './useNextCard';

vi.mock('../../lib/collision', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/collision')>()),
  tauriCollisionApi: { list: () => Promise.resolve([]), ignore: vi.fn(), settingsGet: vi.fn(), settingsSet: vi.fn(), onChanged: () => Promise.resolve(() => {}) },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (Element.prototype as { scrollIntoView?: () => void }).scrollIntoView = () => {};
  window.localStorage.setItem('pm.cockpit.everSpawned', '1');
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  window.localStorage.clear();
  vi.useRealTimers();
});

const NOW = 600_000;
const q = (id: string, agent: string, age: number): Question => ({
  id,
  agent,
  question: `Question from ${agent}?`,
  choices: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }],
  allow_free_text: false,
  urgency: 'normal',
  created_at_ms: NOW - age,
  expires_at_ms: NOW + 600_000,
  state: 'pending',
});
const info = (id: string, status: string): PaneInfo =>
  ({ id, agent_type: 'claude', pid: 1, status, created_at: 1, last_output_at: null, cwd: 'C:\\work\\shop', cols: 80, rows: 24, title: null }) as unknown as PaneInfo;

function api(questions: Question[], answerQuestion: (id: string) => void, prompts: Record<string, PanePrompt> = {}, waiting: string[] = []): CockpitApi {
  const list = waiting.map((id) => ({ info: info(id, 'waiting_input'), status: 'waiting_input' }));
  return {
    registry: { paneList: list, panes: new Map(list.map((p) => [p.info.id, p])), initialReady: true },
    names: new Map([['w1', 'Claude']]),
    asked: { questions, answerQuestion, dismissQuestion: vi.fn() },
    launchEntries: [],
    readyAgents: new Set<string>(),
    mode: 'orchestration',
    theme: 'dark',
    selectedId: null,
    select: vi.fn(),
    prompts,
    statusSince: new Map(waiting.map((id) => [id, NOW - 1000])),
    now: NOW,
    spawn: null,
    answer: vi.fn(),
    interrupt: vi.fn(),
    newAgent: vi.fn(),
  } as unknown as CockpitApi;
}

const cards = () => Array.from(host.querySelectorAll<HTMLElement>('[data-ib-card]'));
const press = (key: string) =>
  act(() => {
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });

describe('focus after an answer', () => {
  it('moves the keyboard to the next card and says whose it is', () => {
    let list = [q('a', 'Planner', 300_000), q('b', 'Reviewer', 200_000), q('c', 'Tester', 100_000)];
    const render = () => act(() => root.render(<Inbox c={api(list, (id) => { list = list.filter((x) => x.id !== id); render(); })} />));
    render();
    expect(cards()).toHaveLength(3);
    // The first card has the keyboard; J goes to the second, so the answer leaves a card in the middle.
    press('j');
    expect(cards()[1].contains(document.activeElement)).toBe(true);
    press('1');
    expect(cards()).toHaveLength(2);
    expect(cards().some((c) => c.textContent?.includes('Reviewer'))).toBe(false);
    // The card now at that spot (Tester) has the focus, with the ring, and the line names it.
    expect(cards()[1].contains(document.activeElement) || cards()[1] === document.activeElement).toBe(true);
    expect(cards()[1].textContent).toContain('Tester');
    expect(document.activeElement?.hasAttribute('data-ring')).toBe(true);
    expect(host.querySelector('.ib-next')?.textContent).toBe('Next: Tester');
    // Pressing again keeps going without touching the mouse, and the last card moves back to the one before it.
    press('1');
    expect(cards()).toHaveLength(1);
    expect(cards()[0].contains(document.activeElement) || cards()[0] === document.activeElement).toBe(true);
    expect(host.querySelector('.ib-next')?.textContent).toBe('Next: Planner');
  });

  it('says nothing and moves nothing when the last card is answered', () => {
    let list = [q('a', 'Planner', 100_000)];
    const render = () => act(() => root.render(<Inbox c={api(list, (id) => { list = list.filter((x) => x.id !== id); render(); })} />));
    render();
    press('1');
    expect(cards()).toHaveLength(0);
    expect(host.querySelector('.ib-next')?.textContent).toBe('');
  });

  it('the line goes away by itself', () => {
    vi.useFakeTimers();
    let list = [q('a', 'Planner', 200_000), q('b', 'Reviewer', 100_000)];
    const render = () => act(() => root.render(<Inbox c={api(list, (id) => { list = list.filter((x) => x.id !== id); render(); })} />));
    render();
    press('1');
    expect(host.querySelector('.ib-next')?.textContent).toBe('Next: Reviewer');
    act(() => void vi.advanceTimersByTime(NEXT_HINT_MS + 10));
    expect(host.querySelector('.ib-next')?.textContent).toBe('');
  });

  it('leaves the keyboard alone when it is in a field', () => {
    let list = [q('a', 'Planner', 200_000), q('b', 'Reviewer', 100_000)];
    const field = document.createElement('input');
    document.body.appendChild(field);
    const render = () => act(() => root.render(<Inbox c={api(list, (id) => { list = list.filter((x) => x.id !== id); render(); })} />));
    render();
    press('1');
    field.focus();
    list = list.filter((x) => x.id !== 'b');
    render();
    expect(document.activeElement).toBe(field);
    field.remove();
  });

  it('picks the card that took the removed one place', () => {
    expect(nextKeyAfter(['a', 'b', 'c'], { key: 'x', index: 1 })).toBe('b');
    expect(nextKeyAfter(['a', 'b'], { key: 'x', index: 5 })).toBe('b');
    expect(nextKeyAfter([], { key: 'x', index: 0 })).toBeNull();
    expect(nextKeyAfter(['a', 'x'], { key: 'x', index: 1 })).toBeNull();
  });
});

describe('key hints on the pane approval card', () => {
  const low: PanePrompt = {
    promptId: 'p1',
    kind: 'command_approval',
    text: 'raw',
    summary: 'Run command: x',
    choices: [{ id: 'yes', label: 'Yes' }, { id: 'always', label: 'Yes, and do not ask again', broad: true }, { id: 'no', label: 'No' }],
    risk: { level: 'low', headline: 'Run tests', reasons: ['It runs tests.'] },
  };
  const high: PanePrompt = { ...low, promptId: 'p2', risk: { level: 'high', headline: 'Delete a folder', reasons: ['It cannot be undone.'] } };

  it('shows 1 2 3 answer and O open on a low-risk card', () => {
    act(() => root.render(<Inbox c={api([], () => {}, { w1: low }, ['w1'])} />));
    const hint = host.querySelector('.ib-approval .ib-hint--card') ?? host.querySelector('[data-ib-card] .ib-hint--card');
    expect(hint?.textContent).toContain('1');
    expect(hint?.textContent).toContain('3');
    expect(hint?.textContent).toContain('answer');
    expect(hint?.textContent).toContain('open');
  });

  it('shows Tab and Enter, never number keys, on a high-risk card', () => {
    act(() => root.render(<Inbox c={api([], () => {}, { w1: high }, ['w1'])} />));
    const hint = host.querySelector('[data-ib-card] .ib-hint--card');
    expect(hint?.textContent).toContain('Tab');
    expect(hint?.textContent).toContain('Enter');
    expect(hint?.textContent).not.toContain('answer');
  });
});
