// @vitest-environment jsdom
// The consent card in Traditional Chinese: the question in the pane's own name, and the answers.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { t } from '../../i18n';
import { useChinese, useEnglish, visibleEnglish } from '../../i18n/test-utils';
import type { Question } from '../../lib/questions';
import { ConsentCard } from './ConsentCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  useChinese();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useEnglish();
});

/** Agent and pane names, and the waiting line from lib/questions (not moved yet), stay English on purpose. */
// "Needs you" is DotSpinner's glyph label (not moved yet): remove it from this list when that file moves.
const AGENT_WORDS = ['Needs', 'you', 'Claude', 'Codex', 'stops', 'waiting', 'in', 'min', 'Delete', 'a', 'folder', 'outside', 'this', 'project'];

const takeOver: Question = {
  id: 'c1',
  agent: 'Claude',
  question: 'Allow Claude to control Codex?',
  choices: [
    { id: 'allow_once', label: 'Allow once' },
    { id: 'always', label: 'Always allow here' },
    { id: 'deny', label: 'Deny' },
  ],
  allow_free_text: false,
  urgency: 'high',
  created_at_ms: 0,
  expires_at_ms: 600_000,
  state: 'pending',
  consent: { action: 'take_over', requester: 'Claude', target: 'Codex', pane_id: 'p-codex' },
};

const answerPrompt: Question = {
  ...takeOver,
  id: 'c2',
  question: 'Allow Claude to answer a question?',
  context: 'Delete a folder outside this project. It did not start this pane.',
  consent: { action: 'answer_prompt', requester: 'Claude', target: 'Codex', pane_id: 'p-codex' },
};

function render(q: Question, paneName?: string) {
  act(() => {
    root.render(
      <ul>
        <ConsentCard q={q} paneName={paneName} now={90_000} onAnswer={() => undefined} onOpenPane={() => undefined} />
      </ul>,
    );
  });
}

const buttonTexts = () => Array.from(host.querySelectorAll('button')).map((b) => b.textContent);

describe('ConsentCard in Traditional Chinese', () => {
  it('asks in the pane name, with Deny first, in Chinese', () => {
    render(takeOver, 'Codex 1');
    expect(visibleEnglish(host, AGENT_WORDS)).toEqual([]);
    expect(host.querySelector('.ib-title')?.textContent).toBe(t('inboxCards.consent.controlTitle', { who: 'Claude', target: 'Codex 1' }));
    expect(buttonTexts()).toEqual([t('inboxCards.consent.deny'), t('inboxCards.consent.allowOnce'), t('inboxCards.consent.alwaysHere'), t('common.open')]);
  });

  it('explains an answer request, quoting what it wants to answer', () => {
    render(answerPrompt, 'Codex 1');
    expect(visibleEnglish(host, AGENT_WORDS)).toEqual([]);
    expect(host.querySelector('.ib-title')?.textContent).toBe(t('inboxCards.consent.answerTitle', { who: 'Claude', target: 'Codex 1' }));
    expect(host.textContent).toContain(t('inboxCards.consent.notStarted'));
  });
});
