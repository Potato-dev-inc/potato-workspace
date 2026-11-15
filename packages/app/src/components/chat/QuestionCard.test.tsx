// @vitest-environment jsdom
// An agent's `question` tool call is a card with options (not "other . question . Failed"), rendered through the real
// ToolRow; picking an option sends the answer back as a message of the chat.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolStep } from '../../lib/sessionChatModel';
import { ChatAnswerContext } from './chatAnswer';
import { questionsOfCall } from './questionCall';
import { ToolRow } from './ToolRow';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const input = {
  questions: [{ header: 'Colour', question: 'Which colour?', options: [{ label: 'Red', description: 'Warm' }, { label: 'Blue', description: 'Cool' }], multiple: false }],
};
const step = (over: Partial<ToolStep['call']> = {}, status: ToolStep['status'] = 'error'): ToolStep => ({
  kind: 'tool',
  id: 't:1',
  call: { kind: 'toolCall', id: 't:1', at: null, callId: '1', name: 'question', summary: 'question', input, ...over },
  result: null,
  status,
});

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
const flush = () => act(async () => { await new Promise((r) => setImmediate(r)); });
const buttons = () => [...host.querySelectorAll<HTMLButtonElement>('.ck-qcard-opt')];

describe('the question tool card', () => {
  it('reads the questions out of the tool input', () => {
    expect(questionsOfCall(step().call)?.[0].options.map((o) => o.label)).toEqual(['Red', 'Blue']);
    expect(questionsOfCall(step({ name: 'bash' }).call)).toBeNull();
    expect(questionsOfCall(step({ input: { command: 'ls' } }).call)).toBeNull();
  });

  it('shows options instead of a failed tool card, and sends the pick back', async () => {
    const send = vi.fn(async () => null);
    act(() => root.render(<ChatAnswerContext.Provider value={send}><ToolRow step={step()} fromScreen={false} /></ChatAnswerContext.Provider>));
    expect(host.querySelector('[data-testid="question-card"]')).not.toBeNull();
    expect(host.textContent).not.toContain('Failed');
    expect(buttons().map((b) => b.textContent)).toEqual(['RedWarm', 'BlueCool']);
    await act(async () => buttons()[1].click());
    await flush();
    expect(send).toHaveBeenCalledWith('My answer to "Which colour?": Blue');
    expect(host.querySelector('[data-testid="question-answered"]')?.textContent).toContain('Blue');
    expect(buttons()).toHaveLength(0);
  });

  it('a multiple question takes several picks and sends them together', async () => {
    const send = vi.fn(async () => null);
    const multi = { questions: [{ question: 'Which?', options: ['A', 'B', 'C'], multiple: true }] };
    act(() => root.render(<ChatAnswerContext.Provider value={send}><ToolRow step={step({ input: multi })} fromScreen={false} /></ChatAnswerContext.Provider>));
    await act(async () => buttons()[0].click());
    await act(async () => buttons()[2].click());
    expect(send).not.toHaveBeenCalled();
    await act(async () => (host.querySelector('.ck-qcard-send') as HTMLButtonElement).click());
    await flush();
    expect(send).toHaveBeenCalledWith('My answer to "Which?": A, C');
  });

  it('keeps the card and says so when the answer could not be sent', async () => {
    const send = vi.fn(async () => 'The chat is closed.');
    act(() => root.render(<ChatAnswerContext.Provider value={send}><ToolRow step={step()} fromScreen={false} /></ChatAnswerContext.Provider>));
    await act(async () => buttons()[0].click());
    await flush();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('The chat is closed.');
    expect(buttons()).toHaveLength(2);
  });

  it('has no buttons that do anything without a way to send', () => {
    act(() => root.render(<ToolRow step={step()} fromScreen={false} />));
    expect(buttons().every((b) => b.disabled)).toBe(true);
  });
});
