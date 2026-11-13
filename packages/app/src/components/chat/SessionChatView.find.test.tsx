// @vitest-environment jsdom
// Find in this chat (Ctrl+F): a box at the top right, a count, Enter and Shift+Enter walk the matches, a folded row
// that holds a match opens by itself, and Esc closes the box and goes back to the message box.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setLanguagePref } from '../../i18n';
import { groupTurns, type ChatItem } from '../../lib/sessionChat';
import { ChatComposer } from './ChatComposer';
import { SessionChatView } from './SessionChatView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let scrolledTo: Array<string | null>;

beforeEach(() => {
  setLanguagePref('en', false);
  scrolledTo = [];
  Element.prototype.scrollIntoView = function (this: HTMLElement) {
    scrolledTo.push(this.textContent);
  };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const ITEMS: ChatItem[] = [
  { kind: 'user', id: 'u1', at: null, text: 'Where is the banana code?' },
  { kind: 'assistant', id: 'a1', at: null, text: 'The banana lives in fruit.ts, and a second banana in bowl.ts.', model: null, finalAnswer: true },
  { kind: 'toolCall', id: 'c1', at: null, callId: 'k1', name: 'Read', summary: 'fruit.ts', paths: ['fruit.ts'] },
  { kind: 'toolResult', id: 'r1', at: null, callId: 'k1', ok: true, output: 'export const secretMango = 1;' },
  { kind: 'turnEnd', id: 'e1', at: null, outcome: 'completed', durationMs: 1000 },
];

function Chat() {
  return (
    <SessionChatView
      state="ready"
      reason={null}
      turns={groupTurns(ITEMS).turns}
      model={null}
      cliVersion={null}
      paneId="p-find"
      composer={<ChatComposer onSend={async () => null} blockedReason={null} />}
    />
  );
}

const view = () => host.querySelector<HTMLElement>('[data-testid="session-chat"]')!;
const key = (target: Element, init: KeyboardEventInit) => act(() => void target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })));
const type = (input: HTMLInputElement, value: string) =>
  act(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 30))));

describe('Find in this chat', () => {
  it('Ctrl+F opens the box with the keyboard in it', () => {
    act(() => root.render(<Chat />));
    expect(host.querySelector('[data-testid="chat-find"]')).toBeNull();
    key(host.querySelector('textarea')!, { key: 'f', ctrlKey: true });
    expect(host.querySelector('[data-testid="chat-find"]')).not.toBeNull();
    expect(document.activeElement).toBe(host.querySelector('.ck-find-input'));
  });

  it('counts the matches and walks them with Enter and Shift+Enter', async () => {
    act(() => root.render(<Chat />));
    key(view(), { key: 'f', ctrlKey: true });
    const input = host.querySelector<HTMLInputElement>('.ck-find-input')!;
    type(input, 'banana');
    await flush();
    const count = () => host.querySelector('[data-testid="chat-find-count"]')!.textContent;
    expect(count()).toBe('1 of 3');
    key(input, { key: 'Enter' });
    expect(count()).toBe('2 of 3');
    key(input, { key: 'Enter' });
    key(input, { key: 'Enter' });
    expect(count()).toBe('1 of 3');
    key(input, { key: 'Enter', shiftKey: true });
    expect(count()).toBe('3 of 3');
    expect(scrolledTo.length).toBeGreaterThan(0);
  });

  it('opens a folded tool step that holds the match, and says so when nothing matches', async () => {
    act(() => root.render(<Chat />));
    expect(host.textContent).not.toContain('secretMango');
    key(view(), { key: 'f', ctrlKey: true });
    const input = host.querySelector<HTMLInputElement>('.ck-find-input')!;
    type(input, 'secretmango');
    await flush();
    expect(host.textContent).toContain('secretMango');
    expect(host.querySelector('[data-testid="chat-find-count"]')!.textContent).toBe('1 of 1');
    type(input, 'zzzz');
    await flush();
    expect(host.querySelector('[data-testid="chat-find-count"]')!.textContent).toBe('No matches');
  });

  it('Esc closes the box and goes back to the message box', () => {
    act(() => root.render(<Chat />));
    key(view(), { key: 'f', ctrlKey: true });
    key(host.querySelector('.ck-find-input')!, { key: 'Escape' });
    expect(host.querySelector('[data-testid="chat-find"]')).toBeNull();
    expect(document.activeElement).toBe(host.querySelector('textarea'));
  });
});
