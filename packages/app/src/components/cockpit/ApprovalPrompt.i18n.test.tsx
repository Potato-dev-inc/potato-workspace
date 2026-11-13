// @vitest-environment jsdom
// The approval card in Traditional Chinese: risk word, caution, "Allow once" / "Always allow" / "Deny", More options.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PanePrompt } from '../../lib/cockpit-api';
import { t } from '../../i18n';
import { useChinese, useEnglish, visibleEnglish } from '../../i18n/test-utils';
import { ApprovalPrompt } from './ApprovalPrompt';

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

const choices = [
  { id: 'allow_once', label: 'Allow once' },
  { id: 'allow_all', label: "Yes, and don't ask again for npm test", broad: true },
  { id: 'deny', label: 'Deny' },
];
// The headline and reasons come from the backend (already in the person's language there).
const prompt = (level: 'low' | 'medium' | 'high'): PanePrompt => ({
  promptId: `p-${level}`,
  kind: 'command_approval',
  text: 'raw',
  summary: 'Run command: rm -rf ../old',
  choices,
  risk: { level, headline: '刪除舊資料夾', reasons: ['這會刪除 ../old 與其中所有內容。', '它在這個專案之外。'] },
});

function render(p: PanePrompt, variant: 'card' | 'bar') {
  act(() => root.render(<ApprovalPrompt prompt={p} onAnswer={vi.fn()} variant={variant} who="Codex · billing" />));
}
// The agent's own menu text stays in each button's tooltip (data, removed before scanning), and so does the command.
const AGENT_WORDS = ['billing', 'rm', 'rf', 'old', 'npm', 'test'];
const english = () => {
  host.querySelectorAll('button[title]').forEach((b) => b.removeAttribute('title'));
  return visibleEnglish(host, AGENT_WORDS);
};
const texts = () => Array.from(host.querySelectorAll('button')).map((b) => b.textContent);

describe('ApprovalPrompt (zh-TW)', () => {
  it.each(['card', 'bar'] as const)('high risk %s: caution, risk word and answers are Chinese', (variant) => {
    render(prompt('high'), variant);
    expect(host.textContent).toContain(t('risk.level.high'));
    expect(host.textContent).toContain(t('risk.caution'));
    expect(texts()).toContain(t('risk.choice.deny'));
    expect(texts()).toContain(t('risk.choice.allowOnce'));
    expect(english()).toEqual([]);
  });

  it('More options opens the always-allow answer in Chinese', () => {
    render(prompt('high'), 'card');
    act(() => (Array.from(host.querySelectorAll('button')).find((b) => b.textContent === t('inboxCards.moreOptions')) as HTMLButtonElement | undefined)?.click());
    expect(texts().some((x) => x?.startsWith(t('risk.choice.alwaysAllow')))).toBe(true);
    expect(english()).toEqual([]);
  });

  it('low risk card has no English', () => {
    render(prompt('low'), 'card');
    expect(host.textContent).toContain(t('risk.level.low'));
    expect(english()).toEqual([]);
  });
});
