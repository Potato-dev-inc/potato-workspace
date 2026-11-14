// @vitest-environment jsdom
// Phone redesign, chat part (steps 1, 2, 10, 12): one type scale, a folded Thought line, no "Done" line under every
// answer, the plan line under the header, and wrapped code. Rendered through PhoneConversation, the phone's real screen.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setLanguagePref } from '../../i18n';
import { PHONE_TEXT_SIZE_KEY, setPhoneTextSize } from '../../lib/phone-text-size';
import { groupTurns, type ChatItem } from '../../lib/sessionChat';
import { PhoneConversation } from './PhoneConversation';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  setLanguagePref('en', false);
  localStorage.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setLanguagePref('en', false);
});

function render(items: ChatItem[]) {
  act(() => {
    root.render(<PhoneConversation state="ready" reason={null} source="file" turns={groupTurns(items).turns} />);
  });
}

const call = (n: number, name: string, summary: string): ChatItem => ({ kind: 'toolCall', id: `c${n}`, at: null, callId: `k${n}`, name, summary, paths: [summary] });
const ok = (n: number): ChatItem => ({ kind: 'toolResult', id: `r${n}`, at: null, callId: `k${n}`, ok: true, output: 'fine' });

const THINK: ChatItem[] = [
  { kind: 'user', id: 'u1', at: null, text: 'hi' },
  { kind: 'thinking', id: 't1', at: null, text: 'They said hi, so I will greet them back.', durationMs: 4000 },
  { kind: 'assistant', id: 'a1', at: null, text: 'Hello!', model: null, finalAnswer: true },
  { kind: 'turnEnd', id: 'e1', at: null, outcome: 'completed', durationMs: 4000 },
];

describe('PhoneConversation redesign (chat part)', () => {
  it('folds the thought to one line "Thought for 4s" and a tap opens it', () => {
    render(THINK);
    const block = host.querySelector('[data-testid="thinking-block"]')!;
    const head = block.querySelector('button')!;
    expect(head.textContent).toBe('Thought for 4s');
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(block.querySelector('.ck-think-fold')?.hasAttribute('data-open')).toBe(false);
    act(() => head.click());
    expect(head.getAttribute('aria-expanded')).toBe('true');
    expect(block.querySelector('.ck-think-fold')?.hasAttribute('data-open')).toBe(true);
  });

  it('says the thought line in Chinese for zh-TW', () => {
    setLanguagePref('zh-TW', false);
    render(THINK);
    expect(host.querySelector('[data-testid="thinking-block"] button')?.textContent).toBe('思考了 4s');
  });

  it('keeps a live thought folded too: "Thinking…" on one line', () => {
    render(THINK.slice(0, 2));
    const head = host.querySelector('[data-testid="thinking-block"] button')!;
    expect(head.textContent).toBe('Thinking…');
    expect(head.getAttribute('aria-expanded')).toBe('false');
  });

  it('has no "Done" line under a finished answer, but still says Stopped', () => {
    render(THINK);
    expect(host.querySelector('.ph-turn-end')).toBeNull();
    expect(host.textContent).not.toMatch(/Done/);
    render([
      { kind: 'user', id: 'u1', at: null, text: 'go' },
      { kind: 'turnEnd', id: 'e1', at: null, outcome: 'interrupted', durationMs: 1000 },
    ]);
    expect(host.querySelector('.ph-turn-end')?.textContent).toBe('Stopped');
  });

  it('names what the folded steps did, in words', () => {
    render([{ kind: 'user', id: 'u1', at: null, text: 'go' }, call(1, 'Read', 'a.ts'), ok(1), call(2, 'Read', 'b.ts'), ok(2), call(3, 'Edit', 'a.ts'), ok(3), call(4, 'Bash', 'npm test'), ok(4)]);
    const line = host.querySelector('[data-testid="phone-fold"] button')!;
    expect(line.textContent).toBe('Read 2 files · Edited 1 file · Ran 1 command');
  });

  it('says the folded steps in Chinese for zh-TW', () => {
    setLanguagePref('zh-TW', false);
    render([{ kind: 'user', id: 'u1', at: null, text: 'go' }, call(1, 'Read', 'a.ts'), ok(1), call(3, 'Edit', 'a.ts'), ok(3)]);
    expect(host.querySelector('[data-testid="phone-fold"] button')?.textContent).toBe('讀了 1 個檔案 · 改了 1 個檔案');
  });

  it('shows the plan line "Step 2 of 3 · name" under the header, and a tap lists the steps', () => {
    render([
      { kind: 'user', id: 'u1', at: null, text: 'go' },
      { kind: 'plan', id: 'p1', at: null, replace: true, items: [{ text: 'Read it', status: 'completed' }, { text: 'Fix it', status: 'in_progress' }, { text: 'Test it', status: 'pending' }] },
    ]);
    const bar = host.querySelector('[data-testid="plan-bar"]')!;
    expect(bar.querySelector('[data-testid="plan-bar-count"]')?.textContent).toBe('Step 2 of 3');
    expect(bar.querySelector('[data-testid="plan-bar-current"]')?.textContent).toBe('· Fix it');
    expect(bar.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('1');
    expect(bar.querySelector('[data-testid="plan-bar-list"]')).toBeNull();
    act(() => bar.querySelector('button')!.click());
    expect(bar.querySelectorAll('[data-testid="plan-bar-list"] li')).toHaveLength(3);
  });

  it('says the plan line in Chinese for zh-TW', () => {
    setLanguagePref('zh-TW', false);
    render([{ kind: 'user', id: 'u1', at: null, text: 'go' }, { kind: 'plan', id: 'p1', at: null, replace: true, items: [{ text: 'a', status: 'in_progress' }, { text: 'b', status: 'pending' }] }]);
    expect(host.querySelector('[data-testid="plan-bar-count"]')?.textContent).toBe('第 1 步，共 2 步');
  });

  it('shows no plan line once every step is done', () => {
    render([{ kind: 'user', id: 'u1', at: null, text: 'go' }, { kind: 'plan', id: 'p1', at: null, replace: true, items: [{ text: 'Only', status: 'completed' }] }]);
    expect(host.querySelector('[data-testid="plan-bar"]')).toBeNull();
  });

  it('puts the text size on the .ph shell: Small, Large, and Normal back to none', () => {
    act(() => root.unmount());
    host.innerHTML = '<div class="ph"><div id="slot"></div></div>';
    root = createRoot(host.querySelector('#slot')!);
    act(() => root.render(<PhoneConversation state="ready" reason={null} source="file" turns={groupTurns(THINK).turns} />));
    const shell = host.querySelector<HTMLElement>('.ph')!;
    expect(shell.dataset.text).toBeUndefined();
    act(() => setPhoneTextSize('large'));
    expect(shell.dataset.text).toBe('large');
    act(() => setPhoneTextSize('small'));
    expect(shell.dataset.text).toBe('small');
    act(() => setPhoneTextSize('normal'));
    expect(shell.dataset.text).toBeUndefined();
    expect(localStorage.getItem(PHONE_TEXT_SIZE_KEY)).toBe('normal');
  });
});

describe('phone type scale (CSS)', () => {
  const css = (name: string) => readFileSync(resolve(process.cwd(), 'src/styles', name), 'utf8').replace(/\r\n/g, '\n');

  it('phone.css defines --fs 15 with Small 14 and Large 17, the shared tokens, and no text auto-size', () => {
    const base = css('phone.css');
    expect(base).toMatch(/--fs: 15px;/);
    expect(base).toMatch(/\[data-text='small'\] \{\s*--fs: 14px;/);
    expect(base).toMatch(/\[data-text='large'\] \{\s*--fs: 17px;/);
    for (const token of ['--fs-sm', '--fs-xs', '--sp-3', '--r-card', '--tap', '--surface', '--raised', '--line', '--text', '--muted', '--faint', '--accent-text', '--ok', '--warn']) {
      expect(base).toContain(`${token}:`);
    }
    expect(base).toContain('text-size-adjust: 100%');
  });

  it('phone-chat.css keeps every font size on the --fs scale, wraps code and gaps items by 10px', () => {
    const chat = css('phone-chat.css');
    const fixed = chat.split('\n').filter((line) => /^\s*font(-size)?:/.test(line) && /\d+(\.\d+)?px/.test(line.replace(/calc\(var\(--fs\)[^)]*\)/g, '')));
    expect(fixed).toEqual([]);
    expect(chat).toMatch(/\.ck-chat-md-pre,[\s\S]*?white-space: pre-wrap;[\s\S]*?overflow-wrap: anywhere;/);
    expect(chat).toMatch(/\.ph-conv-body \{\s*gap: var\(--gap-item\);/);
  });
});
