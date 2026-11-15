// @vitest-environment jsdom
// A `potato-result` fenced block (from an older prompt or another agent) is data for the tools: the chat hides it, keeps
// the words around it, and shows nothing at all (no empty code box, no Copy button) when the block was the whole reply.
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
  Element.prototype.scrollIntoView = function () {};
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const at = (min: number) => new Date(Date.UTC(2026, 10, 16, 1, min, 0)).toISOString();
function render(reply: string) {
  const items: ChatItem[] = [
    { kind: 'user', id: 'u1', at: at(0), text: 'do it' },
    { kind: 'assistant', id: 'a1', at: at(1), text: reply, model: null, finalAnswer: true },
    { kind: 'turnEnd', id: 'e1', at: at(2), outcome: 'completed', durationMs: 1000 },
  ];
  act(() => root.render(<SessionChatView state="ready" reason={null} turns={groupTurns(items).turns} model={null} cliVersion={null} paneId="p-rb" />));
}

describe('potato-result block in the chat', () => {
  it('an empty block alone shows no code box and no Copy button', () => {
    render('```potato-result\n{"summary":"","files_changed":[],"checks_run":[],"open_questions":[]}\n```');
    expect(host.textContent).not.toContain('potato-result');
    expect(host.querySelector('button.ck-chat-md-copy')).toBeNull();
    expect(host.querySelector('pre')).toBeNull();
  });

  it('keeps the words around the block and drops only the block', () => {
    render('All done, I fixed the typo.\n\n```potato-result\n{"summary":"x","files_changed":["a.txt"]}\n```\n\nBye.');
    expect(host.textContent).toContain('All done, I fixed the typo.');
    expect(host.textContent).toContain('Bye.');
    expect(host.textContent).not.toContain('potato-result');
    expect(host.textContent).not.toContain('files_changed');
  });

  it('an ordinary code block is still shown', () => {
    render('Run this:\n\n```bash\nnpm test\n```');
    expect(host.textContent).toContain('npm test');
  });
});
