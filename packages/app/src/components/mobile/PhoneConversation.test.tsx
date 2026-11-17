// @vitest-environment jsdom
// The phone's conversation: the agent's text at full width, your messages in a soft bubble, tool steps folded to one line
// per turn (one tap opens the list), and a failed step never folded (D11).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setPhoneMotion } from '../../lib/phone-motion';
import { groupTurns, type ChatItem } from '../../lib/sessionChat';
import { setLanguagePref } from '../../i18n';
import { foldTurnSteps } from './foldSteps';
import { PhoneConversation } from './PhoneConversation';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  setLanguagePref('en', false);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const at = (sec: number) => new Date(Date.UTC(2026, 10, 13, 1, 0, sec)).toISOString();
const call = (n: number, name: string, summary: string, sec: number): ChatItem => ({ kind: 'toolCall', id: `c${n}`, at: at(sec), callId: `k${n}`, name, summary, paths: [summary] });
const result = (n: number, ok: boolean, sec: number): ChatItem => ({ kind: 'toolResult', id: `r${n}`, at: at(sec), callId: `k${n}`, ok, output: ok ? 'fine' : 'boom: exit 1' });

/** The person asks; the agent reads two files, runs a command that fails, edits a file, then answers. */
const TURN: ChatItem[] = [
  { kind: 'user', id: 'u1', at: null, text: 'fix the title' },
  call(1, 'Read', 'src/a.ts', 0),
  result(1, true, 1),
  call(2, 'Read', 'src/b.ts', 2),
  result(2, true, 3),
  call(3, 'Bash', 'npm test', 4),
  result(3, false, 20),
  call(4, 'Edit', 'src/a.ts', 21),
  result(4, true, 22),
  { kind: 'assistant', id: 'a1', at: null, text: 'The title is fixed.', model: null, finalAnswer: true },
  { kind: 'turnEnd', id: 'e1', at: null, outcome: 'completed', durationMs: 252_000 },
];

function render(items: ChatItem[], extra: Partial<Parameters<typeof PhoneConversation>[0]> = {}) {
  const grouped = groupTurns(items);
  act(() => {
    root.render(<PhoneConversation state="ready" reason={null} source="file" turns={grouped.turns} {...extra} />);
  });
}

describe('foldTurnSteps', () => {
  it('folds the steps that went well into one piece at the first one, and keeps the failed one where it was', () => {
    const steps = groupTurns(TURN).turns[0]!.steps;
    const pieces = foldTurnSteps(steps);
    expect(pieces.map((p) => p.kind)).toEqual(['fold', 'failed', 'step']);
    const fold = pieces[0]!;
    expect(fold.kind === 'fold' && fold.steps.map((s) => s.call.summary)).toEqual(['src/a.ts', 'src/b.ts', 'src/a.ts']);
  });

  it('makes no fold for a turn with no steps', () => {
    const steps = groupTurns([{ kind: 'user', id: 'u', at: null, text: 'hi' }, { kind: 'assistant', id: 'a', at: null, text: 'hello', model: null, finalAnswer: true }]).turns[0]!.steps;
    expect(foldTurnSteps(steps).map((p) => p.kind)).toEqual(['step']);
  });
});

describe('PhoneConversation', () => {
  it('shows your message in a soft bubble and the agent text on its own, full width', () => {
    render(TURN);
    expect(host.querySelector('.ph-you-bubble')?.textContent).toBe('fix the title');
    expect(host.querySelector('.ph-agent-text')?.textContent).toContain('The title is fixed.');
    expect(host.querySelector('.ph-agent-text .ph-you-bubble')).toBeNull();
  });

  it('folds the steps that went well into one line, closed at first, and one tap opens the list', () => {
    render(TURN);
    const folds = host.querySelectorAll('[data-testid="phone-fold"]');
    expect(folds).toHaveLength(1);
    const line = folds[0]!.querySelector('button') as HTMLButtonElement;
    expect(line.textContent).toContain('Read 2 files · Edited 1 file');
    expect(line.getAttribute('aria-expanded')).toBe('false');
    expect(folds[0]!.querySelectorAll('.ck-agc-card, [data-tool-row]').length).toBe(0);
    const before = host.textContent ?? '';
    expect(before).not.toContain('src/b.ts');
    act(() => line.click());
    expect(line.getAttribute('aria-expanded')).toBe('true');
    expect(host.textContent).toContain('src/b.ts');
  });

  it('never folds a failed step: it stays as its own row with its detail open', () => {
    render(TURN);
    const failed = host.querySelectorAll('[data-testid="phone-failed-step"]');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.textContent).toContain('npm test');
    expect(failed[0]!.textContent).toContain('Failed');
    // The failed step is not one of the folded three.
    expect(host.querySelector('[data-testid="phone-fold"]')?.textContent).not.toContain('npm test');
  });

  it('says what runs now in plain words while the turn works, never the command', () => {
    render([{ kind: 'user', id: 'u1', at: null, text: 'go' }, call(1, 'Bash', 'npm run build', 0)]);
    const fold = host.querySelector('[data-testid="phone-fold"]')!;
    expect(fold.textContent).toBe('Running a command');
    expect(fold.textContent).not.toContain('npm run build');
  });

  it('shows the dock, the pending bubbles and the composer under the conversation', () => {
    render(TURN, { dock: <div data-testid="dock">Allow?</div>, pending: <div data-testid="pend">waiting</div>, composer: <div data-testid="comp" /> });
    expect(host.querySelector('.ph-conv-dock')?.textContent).toBe('Allow?');
    expect(host.querySelector('[data-testid="pend"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="comp"]')).not.toBeNull();
  });

  it('an unavailable chat says why and shows no composer', () => {
    render([], { state: 'unavailable', reason: 'This agent is not running any more.', composer: <div data-testid="comp" /> });
    expect(host.textContent).toContain('Chat unavailable');
    expect(host.textContent).toContain('This agent is not running any more.');
    expect(host.querySelector('[data-testid="comp"]')).toBeNull();
  });
});

describe('Smooth text: the last agent message of a running turn', () => {
  const LONG = Array.from({ length: 70 }, (_, i) => `word${i}`).join(' ').slice(0, 300);
  const running = (text: string): ChatItem[] => [
    { kind: 'user', id: 'u1', at: null, text: 'go' },
    { kind: 'assistant', id: 'a1', at: null, text, model: null, finalAnswer: false },
  ];
  const agentText = () => host.querySelector('.ph-agent-text')?.textContent ?? '';
  const tick = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
  beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); });
  afterEach(() => { vi.useRealTimers(); localStorage.clear(); });

  it('a 300-letter update is not all there after one tick, and is all there once the timers run', () => {
    render(running('Start'));
    expect(agentText()).toBe('Start');
    render(running(LONG));
    tick(24);
    expect(agentText().length).toBeGreaterThan(0);
    expect(agentText().length).toBeLessThan(LONG.length);
    expect(LONG.startsWith(agentText())).toBe(true);
    tick(10_000);
    expect(agentText()).toBe(LONG);
  });

  it('shows it at once with reduced motion', () => {
    setPhoneMotion('reduce');
    render(running('Start'));
    render(running(LONG));
    expect(agentText()).toBe(LONG);
  });

  it('shows it at once when the turn is over (the chat is not live)', () => {
    render([...running('Start')]);
    render([...running(LONG), { kind: 'turnEnd', id: 'e1', at: null, outcome: 'completed', durationMs: 1000 }]);
    expect(agentText()).toBe(LONG);
  });

  it('never holds back an ask: the dock is there at once while the text is still coming out', () => {
    render(running('Start'));
    render(running(LONG), { dock: <div data-testid="the-dock">Allow once?</div> });
    expect(host.querySelector('[data-testid="the-dock"]')).not.toBeNull();
    expect(agentText().length).toBeLessThan(LONG.length);
  });
});
