// @vitest-environment jsdom
// The price tag under a finished answer: time, steps, files changed; a yellow mark and one plain tip on a turn far
// above what is usual for the chat; the files are listed when the line is pressed.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setLanguagePref } from '../../i18n';
import { groupTurns, type ChatItem } from '../../lib/sessionChat';
import { SessionChatView } from './SessionChatView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  setLanguagePref('en', false);
  localStorage.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function turn(n: number, reads: number, ms: number, edit = false): ChatItem[] {
  const items: ChatItem[] = [
    { kind: 'user', id: `u${n}`, at: null, text: `ask ${n}` },
  ];
  for (let i = 0; i < reads; i++) {
    items.push({ kind: 'toolCall', id: `c${n}-${i}`, at: null, callId: `k${n}-${i}`, name: 'Read', summary: `f${n}-${i}.ts`, paths: [`src/f${n}-${i}.ts`] });
    items.push({ kind: 'toolResult', id: `r${n}-${i}`, at: null, callId: `k${n}-${i}`, ok: true, output: 'x' });
  }
  if (edit) {
    items.push({ kind: 'toolCall', id: `ce${n}`, at: null, callId: `ke${n}`, name: 'Edit', summary: 'App.tsx', paths: ['src/App.tsx'], writes: true });
    items.push({ kind: 'toolResult', id: `re${n}`, at: null, callId: `ke${n}`, ok: true, output: 'x' });
  }
  items.push({ kind: 'assistant', id: `a${n}`, at: null, text: `done ${n}`, model: null, finalAnswer: true });
  items.push({ kind: 'turnEnd', id: `e${n}`, at: null, outcome: 'completed', durationMs: ms });
  return items;
}

const render = (items: ChatItem[]) =>
  act(() => root.render(<SessionChatView state="ready" reason={null} turns={groupTurns(items).turns} model={null} cliVersion={null} paneId="p-price" />));
const tags = () => [...host.querySelectorAll('[data-testid="turn-price"]')];

describe('Turn price tag', () => {
  it('shows time, steps and files changed under a finished answer', () => {
    render(turn(1, 2, 125_000, true));
    expect(tags()).toHaveLength(1);
    expect(tags()[0].textContent).toBe('2m 5s · 3 steps · 1 file changed');
    expect(tags()[0].getAttribute('data-heavy')).toBeNull();
  });

  it('lists the changed files when the line is pressed', () => {
    render(turn(1, 1, 5000, true));
    const line = tags()[0].querySelector<HTMLButtonElement>('button')!;
    expect(host.querySelector('.ck-price-files')).toBeNull();
    act(() => void line.click());
    expect(host.querySelector('.ck-price-files')!.textContent).toBe('App.tsx');
  });

  it('has no tag under a turn that did no steps, or one that is still running', () => {
    render([...turn(1, 0, 3000), { kind: 'user', id: 'u2', at: null, text: 'working' }, { kind: 'toolCall', id: 'cw', at: null, callId: 'kw', name: 'Read', summary: 'x', paths: ['x'] }]);
    expect(tags()).toHaveLength(0);
  });

  it('marks a turn far above the usual and gives one tip', () => {
    render([...turn(1, 3, 30_000), ...turn(2, 4, 40_000), ...turn(3, 3, 35_000), ...turn(4, 20, 300_000)]);
    const heavy = tags().filter((tag) => tag.getAttribute('data-heavy'));
    expect(heavy).toHaveLength(1);
    expect(heavy[0].querySelector('.ck-price-mark')).not.toBeNull();
    expect(heavy[0].querySelector('[data-testid="turn-price-tip"]')!.textContent).toBe('Most of this was reading 20 files. Name the file next time.');
  });
});
