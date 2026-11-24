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

describe('a tool permission in the Inbox (a far chat) uses the dock translated words', () => {
  it('shows the translated Yes / Yes for this session / No', () => {
    render({
      ...base,
      kind: 'acp_permission',
      choices: [
        { id: 'allow_once', label: 'Yes' },
        { id: 'allow_always', label: 'Yes, allow all edits during this session' },
        { id: 'reject_once', label: 'No' },
      ],
    });
    const texts = buttonTexts();
    expect(texts).toContain(t('risk.choice.allowOnce'));
    expect(texts).toContain(t('risk.choice.allowSession'));
    expect(texts).toContain(t('risk.choice.deny'));
    expect(texts).not.toContain('Yes');
  });
});

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

describe('a tool permission card in Chinese', () => {
  const perm = (what: string): Question => ({ ...base, agent: undefined, kind: 'acp_permission', question: `Claude asks permission: ${what}`, choices: [] });
  const title = () => host.querySelector('.ib-title')!.textContent;
  it('translates every verb and spaces it from the file name', () => {
    for (const [what, zh] of [['Write perm11.txt', '寫入 perm11.txt'], ['Edit a.ts', '編輯 a.ts'], ['Run npm test', '執行指令 npm test'], ['Read b.md', '讀取 b.md'], ['Delete c', '刪除 c'], ['Move d', '移動 d'], ['Fetch https://x.y', '擷取 https://x.y'], ['Search foo', '搜尋 foo']]) {
      render(perm(what));
      expect(title()).toBe(`Claude 想要${zh}`);
    }
  });
  it('names an MCP tool by its tool, not the raw mcp__ id', () => {
    render(perm('mcp__potato-workspace__ask_user'));
    expect(title()).toBe('Claude 想要使用 ask_user 工具');
    expect(title()).not.toContain('mcp__');
  });
  it('an agent sentence with no known verb keeps its words, spaced from the Chinese', () => {
    render(perm('Show hostname and OS info'));
    expect(title()).toBe('Claude 想要 show hostname and OS info');
  });
  it('says who wants to do what, and the badge says Permission', () => {
    render({ ...base, agent: undefined, kind: 'acp_permission', question: 'Claude asks permission: Write perm3.txt', choices: [] });
    expect(host.querySelector('.ib-title')!.textContent).toBe('Claude 想要寫入 perm3.txt');
    expect(host.querySelector('.ib-chip')!.textContent).toBe(t('inbox.chipPermission'));
  });
});
