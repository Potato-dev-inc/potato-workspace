// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { groupTurns, type ChatItem } from '../../lib/sessionChatModel';
import { ThinkingBlock, thoughtLabel } from './ThinkingBlock';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const open = () => host.querySelector('.ck-think-fold')!.hasAttribute('data-open');
const label = () => host.querySelector('.ck-think-h > span')?.textContent;

describe('ThinkingBlock', () => {
  it('words', () => {
    expect(thoughtLabel(true, 5000)).toBe('Thinking…');
    expect(thoughtLabel(false, 6000)).toBe('Thought for 6s');
    expect(thoughtLabel(false, null)).toBe('Thought');
    expect(thoughtLabel(false, 300)).toBe('Thought');
  });

  it('is open and shimmering while it streams, folds when it stops, and a click opens it again', () => {
    act(() => root.render(<ThinkingBlock text="hmm" streaming durationMs={null} />));
    expect(open()).toBe(true);
    expect(host.querySelector('.ck-shim')?.textContent).toBe('Thinking…');
    act(() => root.render(<ThinkingBlock text="hmm" streaming={false} durationMs={6200} />));
    expect(open()).toBe(false);
    expect(label()).toBe('Thought for 6s');
    act(() => host.querySelector<HTMLButtonElement>('.ck-think-h')!.click());
    expect(open()).toBe(true);
    expect(host.querySelector('.ck-think-h')!.getAttribute('aria-expanded')).toBe('true');
  });

  it('a block the person opened is not folded again by the app', () => {
    act(() => root.render(<ThinkingBlock text="hmm" streaming={false} durationMs={null} />));
    act(() => host.querySelector<HTMLButtonElement>('.ck-think-h')!.click());
    act(() => root.render(<ThinkingBlock text="hmm more" streaming={false} durationMs={null} />));
    expect(open()).toBe(true);
  });
});

describe('thinking in the turn model', () => {
  it('a thinking item is a step of its turn, in order; an empty one is ignored', () => {
    const items: ChatItem[] = [
      { kind: 'user', id: 'u1', at: null, text: 'go' },
      { kind: 'thinking', id: 'th1.1', at: null, text: 'first', durationMs: 1000 },
      { kind: 'assistant', id: 'a1.1', at: null, text: 'ok', model: null, finalAnswer: false },
      { kind: 'thinking', id: 'th1.2', at: null, text: '  ' },
    ];
    const { turns } = groupTurns(items);
    expect(turns[0]!.steps.map((s) => s.kind)).toEqual(['thinking', 'text']);
  });
});
