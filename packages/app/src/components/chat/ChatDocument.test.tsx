// @vitest-environment jsdom
// Proposal 21, chat that reads like a document. jsdom has no layout, so this pins the structure and the style
// rules: tool steps keep their tick/cross icon and a hidden word, code words are chips, and the stylesheet sets the
// 72-character column, hairline-only tables and the green tick / red cross.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StatusBadge } from './ToolRow';
import { ChatMarkdown } from './ChatMarkdown';

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

const css = readFileSync(resolve(process.cwd(), 'src/styles/cockpit-chat-activity.css'), 'utf8');

describe('chat document look', () => {
  it('a finished tool step has a tick icon, a failed one a cross, each with its word for screen readers', () => {
    act(() => root.render(<><StatusBadge state="done" /><StatusBadge state="failed" /></>));
    const badges = [...host.querySelectorAll('.ck-agc-badge')];
    expect(badges[0].querySelector('.ck-agc-check')).not.toBeNull();
    expect(badges[0].textContent).toBe('Done');
    expect(badges[1].querySelector('.ck-agc-cross')).not.toBeNull();
    expect(badges[1].textContent).toBe('Failed');
  });

  it('code words in the agent text are code chips and tables sit in a scrolling wrap', () => {
    act(() => root.render(<ChatMarkdown text={'Edited `src/login.ts`.\n\n| File | Change |\n| --- | --- |\n| login.ts | moved |\n'} />));
    expect(host.querySelector('code.ck-chat-md-code')?.textContent).toBe('src/login.ts');
    expect(host.querySelector('.ck-chat-md-table-wrap .ck-chat-md-table')).not.toBeNull();
  });

  it('the stylesheet centres a 72ch column, uses tokens for tick and cross, and draws hairline tables', () => {
    expect(css).toMatch(/\.ck-chat-body\s*{[^}]*72ch/);
    expect(css).toMatch(/\.ck-agc-check\s*{\s*color: var\(--live\)/);
    expect(css).toMatch(/\.ck-agc-cross\s*{\s*color: var\(--danger\)/);
    expect(css).toMatch(/\.ck-chat-md-table td\s*{[^}]*border: 0;[^}]*border-bottom: 1px solid var\(--sep\)/);
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
  });
});
