// @vitest-environment jsdom
// The question card in Traditional Chinese: no English left on screen except the agent's own words.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { t } from '../../i18n';
import { useChinese, useEnglish, visibleEnglish } from '../../i18n/test-utils';
import type { Question } from '../../lib/questions';
import { QuestionCard } from './QuestionCard';

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

/** The agent's own words (the question, the choices) and the waiting line from lib/questions stay English on purpose. */
// The glyph label "Needs you" is DotSpinner's (not moved yet): remove it from this list when that file moves.
const AGENT_WORDS = ['Needs', 'you', 'Planner', 'Which', 'database', 'Postgres', 'SQLite', 'stops', 'waiting', 'in', 'min'];

const base: Question = {
  id: 'q1',
  agent: 'Planner',
  question: 'Which database?',
  choices: [
    { id: 'pg', label: 'Postgres' },
    { id: 'sq', label: 'SQLite' },
  ],
  allow_free_text: true,
  urgency: 'normal',
  created_at_ms: 0,
  expires_at_ms: 600_000,
  state: 'pending',
};

function render(q: Question, onOpenPane?: () => void) {
  act(() => {
    root.render(
      <ul>
        <QuestionCard q={q} now={90_000} onAnswer={() => undefined} onDismiss={() => undefined} onOpenPane={onOpenPane} />
      </ul>,
    );
  });
}

const buttonTexts = () => Array.from(host.querySelectorAll('button')).map((b) => b.textContent);

describe('QuestionCard in Traditional Chinese', () => {
  it('shows the answer field, Send, Dismiss and Open in Chinese, with no English left', () => {
    render(base, () => undefined);
    expect(visibleEnglish(host, AGENT_WORDS)).toEqual([]);
    expect(host.querySelector('input')?.getAttribute('placeholder')).toBe(t('inboxCards.question.orType'));
    expect(host.querySelector('input')?.getAttribute('aria-label')).toBe(t('inboxCards.question.yourAnswer'));
    expect(buttonTexts()).toContain(t('inboxCards.send'));
    expect(buttonTexts()).toContain(t('inboxCards.dismiss'));
    expect(buttonTexts()).toContain(t('common.open'));
  });

  it('asks for a typed answer in Chinese when there are no choices', () => {
    render({ ...base, choices: [] });
    expect(visibleEnglish(host, AGENT_WORDS)).toEqual([]);
    expect(host.querySelector('input')?.getAttribute('placeholder')).toBe(t('inboxCards.question.typeAnswer'));
  });
});
