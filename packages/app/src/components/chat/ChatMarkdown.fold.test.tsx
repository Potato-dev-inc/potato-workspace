// @vitest-environment jsdom
// Fold long code and long output: over 30 lines a code block shows 30 and "Show all N lines"; Copy copies everything;
// Find in this chat opens a fold that holds a match; a tool's long output folds the same way.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatMarkdown } from './ChatMarkdown';
import { ChatFindContext } from './chatFind';
import { OutputBlock } from './ToolDetail';
import { countLines, firstLines } from './chatFold';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const lines = (n: number, tag = 'line'): string => Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`).join('\n');
const fence = (body: string): string => '```ts\n' + body + '\n```';
const render = (node: React.ReactNode): void => {
  act(() => root.render(node));
};
const code = (): string => host.querySelector('pre code')?.textContent ?? '';
const toggle = (): HTMLButtonElement | null => host.querySelector('[data-testid="fold-toggle"]');
const click = (el: HTMLElement): void => {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

describe('fold helpers', () => {
  it('counts lines without a trailing newline and cuts at the limit', () => {
    expect(countLines('a\nb\n')).toBe(2);
    expect(countLines('')).toBe(0);
    expect(firstLines('a\nb\nc', 2)).toBe('a\nb');
    expect(firstLines('a\nb', 5)).toBe('a\nb');
  });
});

describe('long code blocks', () => {
  it('stays whole at exactly 30 lines', () => {
    render(<ChatMarkdown text={fence(lines(30))} />);
    expect(toggle()).toBeNull();
    expect(code()).toBe(lines(30));
  });

  it('folds at 31 lines, shows Show all N lines, and opens and closes on click', () => {
    render(<ChatMarkdown text={fence(lines(400))} />);
    expect(code()).toBe(lines(30));
    expect(toggle()?.textContent).toBe('Show all 400 lines');
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false');
    click(toggle()!);
    expect(code()).toBe(lines(400));
    expect(toggle()?.textContent).toBe('Show less');
    click(toggle()!);
    expect(code()).toBe(lines(30));
  });

  it('Copy copies every line even while folded', async () => {
    render(<ChatMarkdown text={fence(lines(100))} />);
    await act(async () => {
      host.querySelector<HTMLButtonElement>('button.ck-chat-md-copy')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(writeText).toHaveBeenCalledWith(lines(100));
  });

  it('Find in this chat opens a fold that holds a match', () => {
    const text = fence(lines(100));
    render(
      <ChatFindContext.Provider value="">
        <ChatMarkdown text={text} />
      </ChatFindContext.Provider>,
    );
    expect(code()).toBe(lines(30));
    render(
      <ChatFindContext.Provider value="line 95">
        <ChatMarkdown text={text} />
      </ChatFindContext.Provider>,
    );
    expect(code()).toBe(lines(100));
    // A query that is not in the block leaves it folded.
    render(
      <ChatFindContext.Provider value="nowhere">
        <ChatMarkdown text={text} />
      </ChatFindContext.Provider>,
    );
    expect(code()).toBe(lines(30));
  });
});

describe('long tool output', () => {
  const result = (output: string) => ({ output }) as never;

  it('folds past 30 lines and Copy still copies all of it', async () => {
    render(<OutputBlock result={result(lines(80, 'out'))} />);
    expect(host.querySelector('[data-testid="tool-output"]')?.textContent).toBe(lines(30, 'out'));
    expect(toggle()?.textContent).toBe('Show all 80 lines');
    await act(async () => {
      host.querySelector<HTMLButtonElement>('button.ck-agc-copy')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(writeText).toHaveBeenCalledWith(lines(80, 'out'));
    click(toggle()!);
    expect(host.querySelector('[data-testid="tool-output"]')?.textContent).toBe(lines(80, 'out'));
  });

  it('a short output has no button', () => {
    render(<OutputBlock result={result('ok')} />);
    expect(toggle()).toBeNull();
  });
});
