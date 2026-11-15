// @vitest-environment jsdom
// Screen level, phone: an agent's `question` tool call is a card with options in the phone's conversation (not a failed
// step folded away), and the pick goes out through the chat's answer sender.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLanguagePref } from '../../i18n';
import { groupTurns, type ChatItem } from '../../lib/sessionChat';
import { ChatAnswerContext } from '../chat/chatAnswer';
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

const ITEMS: ChatItem[] = [
  { kind: 'user', id: 'u1', at: null, text: 'pick' },
  { kind: 'toolCall', id: 't:q', at: null, callId: 'q', name: 'question', summary: 'question', input: { questions: [{ question: 'Which colour?', options: [{ label: 'Red' }, { label: 'Blue' }] }] } },
  { kind: 'toolResult', id: 'r:q', at: null, callId: 'q', ok: false, summary: 'Failed', output: 'no picker' } as ChatItem,
];

describe('the phone conversation with a question tool call', () => {
  it('draws the options and sends the pick', async () => {
    const send = vi.fn(async () => null);
    act(() => root.render(
      <ChatAnswerContext.Provider value={send}>
        <PhoneConversation state="ready" reason={null} source="file" turns={groupTurns(ITEMS).turns} />
      </ChatAnswerContext.Provider>,
    ));
    expect(host.querySelector('[data-testid="question-card"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="phone-failed-step"]')).toBeNull();
    const red = [...host.querySelectorAll<HTMLButtonElement>('.ck-qcard-opt')].find((b) => b.textContent === 'Red')!;
    await act(async () => red.click());
    expect(send).toHaveBeenCalledWith('My answer to "Which colour?": Red');
  });
});
