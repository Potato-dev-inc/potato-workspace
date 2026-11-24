// @vitest-environment jsdom
// Sameness for the jump-out card: a question another PC waits on is drawn by the SAME QuestionCard as a local one. Fed through the real
// far parser (`farQuestionsOf`) and `asQuestion`, its HTML equals the local question's after the usual swap (the far key and the host line).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QuestionCard } from '../../components/cockpit/QuestionCard';
import type { Question } from '../../lib/questions';
import { asQuestion, farQuestionsOf } from '../../lib/runtime/farQuestions';

vi.mock('@tauri-apps/api/core', () => ({ invoke: async () => null }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => undefined, emit: async () => undefined }));
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

const NOW = 1_700_000_000_000;
const NODE = 'b2'.repeat(32);
const RAW_QUESTION = { id: 'q1', pane_id: 'p1', question: 'Which branch should I use?', choices: [{ id: 'main', label: 'main' }, { id: 'dev', label: 'dev' }], allow_free_text: true, urgency: 'normal', created_at_ms: NOW, expires_at_ms: NOW + 600_000, state: 'pending' };

describe('sameness: the jump-out card for a far question', () => {
  it('is the local question card, word for word, apart from the far key and the host line', () => {
    const [far] = farQuestionsOf(NODE, 'Mac mini', [RAW_QUESTION], () => NOW);
    const asFar = asQuestion(far!, 'On Mac mini');
    const local: Question = { ...asFar, id: 'q1', context: 'On Mac mini', expires_at_ms: asFar.expires_at_ms };
    const html = (q: Question) => {
      act(() => root.render(<QuestionCard q={q} now={NOW + 1000} onAnswer={() => undefined} />));
      return host.innerHTML.replace(q.id, 'ID');
    };
    expect(html(asFar)).toBe(html(local));
    expect(asFar.id).toBe(`dev:${NODE}:q1`);
    // No Dismiss on either: the jump-out passes none.
    expect(host.querySelector('[data-ib="dismiss"]')).toBeNull();
  });
});
