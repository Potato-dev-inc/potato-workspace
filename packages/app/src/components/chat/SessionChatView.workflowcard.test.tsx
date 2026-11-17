// @vitest-environment jsdom
// Screen level: a chat the app started from a workflow shows ONE "Using workflow" card (closed), then the person's words
// as a normal bubble. Open, the card shows the whole brief. Old chats and a typed look-alike stay plain text.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { groupTurns, type ChatItem } from '../../lib/sessionChat';
import { recordWorkflowStart, workflowFirstMessage } from '../../lib/workflowCard';
import { buildRailEntries } from './messageRailModel';
import { useEnglish } from '../../i18n/test-utils';
import { SessionChatView } from './SessionChatView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
useEnglish();

const BRIEF = 'You are the front of the workflow "Research + Write".\nYour rules:\n- write it\n';
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const items = (first: string): ChatItem[] => [
  { kind: 'user', id: 'u1', at: null, text: first },
  { kind: 'assistant', id: 'a1', at: null, text: 'ok', model: null, finalAnswer: true },
  { kind: 'turnEnd', id: 'end:1', at: null, outcome: 'completed', durationMs: 1000 },
];

async function show(first: string, paneId = 'p1') {
  await act(async () => {
    root.render(<SessionChatView state="ready" reason={null} source="acp" turns={groupTurns(items(first)).turns} model={null} cliVersion={null} paneId={paneId} />);
  });
}
const card = () => host.querySelector('[data-testid="workflow-card"]');
const bubbles = () => [...host.querySelectorAll('.ck-chat-bubble')].map((n) => n.textContent);

describe('workflow card in the chat', () => {
  it('is closed by default and the person gets a normal bubble', async () => {
    recordWorkflowStart('p1', { name: 'Research + Write', brief: BRIEF });
    await show(workflowFirstMessage(BRIEF, 'hi'));
    expect(card()?.textContent).toContain('Using workflow: Research + Write');
    expect(host.querySelector('[data-testid="workflow-card-text"]')).toBeNull();
    expect(host.textContent).not.toContain('Your rules');
    expect(bubbles()).toEqual(['hi']);
    expect(host.querySelectorAll('[data-rail-id="u1"]').length).toBe(1);
  });

  it('opens on click to show the whole brief, and closes again', async () => {
    recordWorkflowStart('p1', { name: 'Research + Write', brief: BRIEF });
    await show(workflowFirstMessage(BRIEF, 'hi'));
    const button = card()!.querySelector('button')!;
    await act(async () => button.click());
    expect(host.querySelector('[data-testid="workflow-card-text"]')?.textContent).toBe(BRIEF.trimEnd());
    expect(button.getAttribute('aria-expanded')).toBe('true');
    await act(async () => button.click());
    expect(host.querySelector('[data-testid="workflow-card-text"]')).toBeNull();
  });

  it('shows only the card when the request is empty', async () => {
    recordWorkflowStart('p1', { name: 'W', brief: BRIEF });
    await show(workflowFirstMessage(BRIEF, ''));
    expect(card()).not.toBeNull();
    expect(bubbles()).toEqual([]);
  });

  it('leaves an old chat (no record) and a typed look-alike exactly as they were', async () => {
    const typed = workflowFirstMessage(BRIEF, 'hi');
    await show(typed, 'old-chat');
    expect(card()).toBeNull();
    expect(bubbles()).toEqual([typed]);
    recordWorkflowStart('p2', { name: 'W', brief: BRIEF });
    await show('hello there', 'p2');
    expect(card()).toBeNull();
    expect(bubbles()).toEqual(['hello there']);
  });

  it('the message rail shows the person words, not the brief', () => {
    const turns = groupTurns(items(workflowFirstMessage(BRIEF, 'hi'))).turns;
    expect(buildRailEntries(turns, 'verbose', new Map([['u1', 'hi']]))[0].text).toBe('hi');
    expect(buildRailEntries(turns, 'verbose')[0].text).toContain('Your rules');
  });
});
