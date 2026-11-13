// @vitest-environment jsdom
// The real editor (not the stand-in the other tests use): it shows the text with line numbers and cannot be typed into.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodeEditor } from './CodeEditor';
import { extensionOf, hasLanguage, isMarkdown, languageFor } from './languages';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no layout; CodeMirror measures text with these.
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);

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

describe('CodeEditor', () => {
  it('shows the file text read-only with line numbers', async () => {
    await act(async () => root.render(<CodeEditor path="a.ts" text={'const a = 1;\nconst b = 2;'} />));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const content = host.querySelector('.cm-content')!;
    expect(content.textContent).toContain('const a = 1;');
    expect(content.textContent).toContain('const b = 2;');
    expect(content.getAttribute('aria-readonly')).toBe('true');
    expect(host.querySelectorAll('.cm-lineNumbers .cm-gutterElement').length).toBeGreaterThanOrEqual(2);
  });

  it('colours code once the language has loaded', async () => {
    await act(async () => root.render(<CodeEditor path="a.ts" text={'const a = 1;'} />));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });
    expect(host.querySelectorAll('.cm-line span').length).toBeGreaterThan(0);
  });
});

describe('languages', () => {
  it('knows the extension and which files are Markdown', () => {
    expect(extensionOf('src/App.TSX')).toBe('tsx');
    expect(extensionOf('Makefile')).toBe('');
    expect(extensionOf('.gitignore')).toBe('');
    expect(isMarkdown('docs/a.md')).toBe(true);
    expect(isMarkdown('a.ts')).toBe(false);
  });
  it('has a language for the kinds we colour and none for the rest', async () => {
    for (const p of ['a.js', 'a.tsx', 'a.rs', 'a.json', 'a.md', 'a.css', 'a.html', 'a.py']) expect(hasLanguage(p), p).toBe(true);
    expect(hasLanguage('a.xyz')).toBe(false);
    expect(languageFor('a.xyz')).toBeNull();
    expect(await languageFor('a.rs')).toBeTruthy();
  });
});
