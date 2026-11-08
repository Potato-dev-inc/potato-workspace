// @vitest-environment jsdom
// What the conversation shows for a chat session: the agent's thoughts as a fold, an answered permission question as one
// quiet line, and the quiet Copy / Retry row under a finished reply.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { groupTurns, type ChatItem } from '../../lib/sessionChat';
import { SessionChatView, type SessionChatViewProps } from './SessionChatView';

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

function render(items: ChatItem[], props: Partial<SessionChatViewProps> = {}) {
  act(() => {
    root.render(<SessionChatView state="ready" reason={null} source="acp" turns={groupTurns(items).turns} model={null} cliVersion={null} {...props} />);
  });
}

const user: ChatItem = { kind: 'user', id: 'u1', at: null, text: 'go' };
const end: ChatItem = { kind: 'turnEnd', id: 'e1', at: null, outcome: 'completed', durationMs: 5000 };
const say = (id: string, text: string, finalAnswer = true): ChatItem => ({ kind: 'assistant', id, at: null, text, model: null, finalAnswer });
const note = (id: string, text: string): ChatItem => ({ kind: 'notice', id, at: null, noticeKind: 'permission', text });
const open = (el: Element) => el.querySelector('.ck-think-fold')!.hasAttribute('data-open');

describe('thinking in the conversation', () => {
  it('is open while it is the last thing of a running turn and folded once something follows', () => {
    const thought: ChatItem = { kind: 'thinking', id: 'th1', at: null, text: 'Looking at the files', durationMs: 4000 };
    render([user, thought]);
    const block = host.querySelector('[data-testid="thinking-block"]')!;
    expect(open(block)).toBe(true);
    expect(block.textContent).toContain('Thinking…');
    render([user, thought, say('a1', 'Done.', false)]);
    const folded = host.querySelector('[data-testid="thinking-block"]')!;
    expect(open(folded)).toBe(false);
    expect(folded.textContent).toContain('Thought for 4s');
  });

  it('is shown in the normal view', () => {
    render([user, { kind: 'thinking', id: 'th1', at: null, text: 'hm' }, say('a1', 'Done.'), end], { paneId: null });
    expect(host.querySelector('[data-testid="thinking-block"]')).not.toBeNull();
  });
});

describe('answered permission questions', () => {
  it('are quiet lines, not ruled separators, and a run of them has no wall of rules', () => {
    render([user, note('perm:1', 'Allowed · Write notes.txt'), note('perm:2', 'Denied · rm -rf dist'), note('perm:3', "Allowed automatically (you said don't ask again) · ls"), say('a1', 'ok'), end]);
    const traces = [...host.querySelectorAll('[data-testid="permission-trace"]')];
    expect(traces.map((t) => t.getAttribute('data-tone'))).toEqual(['allow', 'deny', 'allow']);
    expect(traces[0]!.textContent).toBe('Allowed · Write notes.txt');
    expect(traces[2]!.getAttribute('data-auto')).toBe('');
    expect(host.querySelectorAll('[data-notice="permission"]').length).toBe(0);
  });
});

describe('the row under a finished reply', () => {
  it('copies the whole message', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render([user, say('a1', 'First part.', false), say('a2', 'Second part.'), end]);
    const rows = host.querySelectorAll('[data-testid="response-actions"]');
    expect(rows.length).toBe(2);
    await act(async () => rows[1]!.querySelector<HTMLButtonElement>('button[aria-label="Copy"]')!.click());
    expect(writeText).toHaveBeenCalledWith('Second part.');
  });

  it('is not drawn under the words still being written', () => {
    render([user, say('a1', 'Typing…', false)]);
    expect(host.querySelector('[data-testid="response-actions"]')).toBeNull();
  });

  it('offers Retry only on the last reply of the newest turn, through the turn ending retry', async () => {
    const onRetry = vi.fn(async () => null);
    render([user, say('a1', 'First part.', false), say('a2', 'Second part.'), end], { endings: { onRetry } });
    const retries = host.querySelectorAll('button[aria-label="Retry"]');
    expect(retries.length).toBe(1);
    await act(async () => retries[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onRetry).toHaveBeenCalledTimes(1);
    render([user, say('a1', 'Second part.'), end]);
    expect(host.querySelector('button[aria-label="Retry"]')).toBeNull();
  });

  it('is not drawn for a chat read off the screen', () => {
    render([user, say('a1', 'Text'), end], { source: 'screen' });
    expect(host.querySelector('[data-testid="response-actions"]')).toBeNull();
  });
});
