// @vitest-environment jsdom
// Fold long code and long output, at screen level: the desktop chat and the phone chat both fold a long code block
// in an answer, Find in this chat opens the fold that holds the match, and an opened tool step folds a long output.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setLanguagePref } from '../../i18n';
import { groupTurns, type ChatItem } from '../../lib/sessionChat';
import { PhoneConversation } from '../mobile/PhoneConversation';
import { ChatComposer } from './ChatComposer';
import { SessionChatView } from './SessionChatView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  setLanguagePref('en', false);
  Element.prototype.scrollIntoView = () => undefined;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const body = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`).join('\n');
const ITEMS: ChatItem[] = [
  { kind: 'user', id: 'u1', at: null, text: 'show me' },
  { kind: 'assistant', id: 'a1', at: null, text: 'Here it is:\n```ts\n' + body(120, 'code') + '\n```\nThat is all.', model: null, finalAnswer: true },
  { kind: 'toolCall', id: 'c1', at: null, callId: 'k1', name: 'Bash', summary: 'ls', paths: [] },
  { kind: 'toolResult', id: 'r1', at: null, callId: 'k1', ok: true, output: body(90, 'out') },
  { kind: 'turnEnd', id: 'e1', at: null, outcome: 'completed', durationMs: 1000 },
];

const key = (target: Element, init: KeyboardEventInit) => act(() => void target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })));
const type = (input: HTMLInputElement, value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 30))));
const codeText = () => host.querySelector('pre.ck-agc-codepre code')?.textContent ?? '';
const fold = () => host.querySelector<HTMLButtonElement>('.ck-agc-codeblock [data-testid="fold-toggle"]');

describe('Fold long code and long output', () => {
  it('the desktop chat folds a long code block, and Show all opens it', () => {
    act(() =>
      root.render(
        <SessionChatView state="ready" reason={null} turns={groupTurns(ITEMS).turns} model={null} cliVersion={null} paneId="p-fold" source="acp" composer={<ChatComposer onSend={async () => null} blockedReason={null} />} />,
      ),
    );
    expect(codeText()).toBe(body(30, 'code'));
    expect(fold()?.textContent).toBe('Show all 120 lines');
    act(() => void fold()!.click());
    expect(codeText()).toBe(body(120, 'code'));
  });

  it('Find in this chat opens the fold that holds the match', async () => {
    act(() =>
      root.render(
        <SessionChatView state="ready" reason={null} turns={groupTurns(ITEMS).turns} model={null} cliVersion={null} paneId="p-fold" source="acp" composer={<ChatComposer onSend={async () => null} blockedReason={null} />} />,
      ),
    );
    key(host.querySelector<HTMLElement>('[data-testid="session-chat"]')!, { key: 'f', ctrlKey: true });
    type(host.querySelector<HTMLInputElement>('.ck-find-input')!, 'code 110');
    await flush();
    expect(codeText()).toBe(body(120, 'code'));
    expect(host.querySelector('[data-testid="chat-find-count"]')!.textContent).toBe('1 of 1');
    // The tool step opens too when the match is in its output, and its long output is whole.
    type(host.querySelector<HTMLInputElement>('.ck-find-input')!, 'out 85');
    await flush();
    expect(host.querySelector('[data-testid="tool-output"]')?.textContent).toBe(body(90, 'out'));
  });

  it('the phone chat folds the same way', () => {
    act(() => root.render(<PhoneConversation state="ready" reason={null} turns={groupTurns(ITEMS).turns} chatId="ph-fold" source="acp" />));
    expect(codeText()).toBe(body(30, 'code'));
    expect(fold()?.textContent).toBe('Show all 120 lines');
  });

  it('zh-TW says it in Chinese', () => {
    setLanguagePref('zh-TW', false);
    act(() => root.render(<PhoneConversation state="ready" reason={null} turns={groupTurns(ITEMS).turns} chatId="ph-fold" source="acp" />));
    expect(fold()?.textContent).toBe('顯示全部 120 行');
  });
});
