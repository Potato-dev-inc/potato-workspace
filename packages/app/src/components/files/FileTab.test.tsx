// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileTab } from './FileTab';
import { fakeApi } from './fakes';
import type { FileContent } from '../../lib/files-api';
import { resetComposerInserts, takeComposerInserts } from '../../lib/composer-insert';
import { useEnglish } from '../../i18n/test-utils';

// CodeMirror needs a real layout engine; the tab is tested with a stand-in that reports a picked range.
vi.mock('./CodeEditor', () => ({
  CodeEditor: ({ path, text, onSelect }: { path: string; text: string; onSelect?: (s: { from: number; to: number; text: string } | null) => void }) => (
    <div data-testid="file-code" data-path={path}>
      <pre>{text}</pre>
      <button type="button" onClick={() => onSelect?.({ from: 2, to: 3, text: 'line two\nline three' })}>
        pick
      </button>
    </div>
  ),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  useEnglish();
  resetComposerInserts();
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

const content = (over: Partial<FileContent>): FileContent => ({ path: 'a.ts', name: 'a.ts', size: 12, kind: 'text', text: 'one', ...over });

async function show(path: string, c: FileContent, api = fakeApi({}, { [path]: c }), canTell = true) {
  await act(async () => root.render(<FileTab paneId="p1" path={path} canTell={canTell} api={api} />));
  await flush();
  return api;
}
const click = async (el: Element | null | undefined) => {
  await act(async () => (el as HTMLElement).click());
  await flush();
};
const button = (label: string) => [...host.querySelectorAll('button, [role="tab"]')].find((b) => b.textContent === label);

const PATCH = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1,2 +1,3 @@', ' keep', '-old', '+new', '+added'].join('\n');

describe('File tab', () => {
  it('shows code with the editor, read-only', async () => {
    const api = await show('src/a.ts', content({ path: 'src/a.ts', text: 'let x = 1;' }));
    expect(api.read).toHaveBeenCalledWith('p1', 'src/a.ts');
    expect(host.querySelector('[data-testid="file-code"]')?.textContent).toContain('let x = 1;');
    expect(host.querySelector('.ck-file-name')?.textContent).toBe('a.ts');
  });

  it('shows Markdown as a page, with a way to see the text', async () => {
    await show('README.md', content({ path: 'README.md', text: '# Title\n\nSome **words**.' }));
    expect(host.querySelector('[data-testid="file-markdown"] h1, [data-testid="file-markdown"] [role="heading"]')?.textContent).toContain('Title');
    expect(host.querySelector('[data-testid="file-code"]')).toBeNull();
    await click(button('Show as text'));
    expect(host.querySelector('[data-testid="file-code"]')).not.toBeNull();
  });

  it('shows a picture as a picture', async () => {
    await show('logo.png', content({ path: 'logo.png', name: 'logo.png', kind: 'image', text: null, dataUrl: 'data:image/png;base64,AAAA' }));
    const img = host.querySelector<HTMLImageElement>('[data-testid="file-image"] img')!;
    expect(img.getAttribute('src')).toBe('data:image/png;base64,AAAA');
    expect(img.alt).toBe('logo.png');
  });

  it('says plainly when the file is over 2 MB', async () => {
    await show('big.log', content({ path: 'big.log', kind: 'too_large', text: null, size: 3 * 1024 * 1024 }));
    expect(host.querySelector('[data-testid="file-too-large"]')?.textContent).toBe('This file is too big to open here (3.0 MB). The limit is 2 MB.');
  });

  it('says so for a file that is not text', async () => {
    await show('a.bin', content({ path: 'a.bin', kind: 'binary', text: null }));
    expect(host.querySelector('.ck-file-body')?.textContent).toBe('This file is not text, so it cannot be shown here.');
  });

  it('says why when the file cannot be read', async () => {
    const api = fakeApi({ read: vi.fn(async () => Promise.reject(new Error('FILES_NOT_FOUND: That file is not there any more.'))) });
    await show('gone.ts', content({}), api);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('not there any more');
  });

  describe('File / Changes switch', () => {
    it('shows the agent change in place', async () => {
      const api = fakeApi({ diff: vi.fn(async () => PATCH) }, { 'a.ts': content({}) });
      await show('a.ts', content({}), api);
      await click(button('Changes'));
      expect(api.diff).toHaveBeenCalledWith('p1', 'a.ts');
      const lines = [...host.querySelectorAll('[data-testid="file-diff"] [role="option"]')].map((l) => l.textContent);
      expect(lines.some((l) => l?.includes('+new'))).toBe(true);
      expect(lines.some((l) => l?.includes('-old'))).toBe(true);
      await click(button('File'));
      expect(host.querySelector('[data-testid="file-code"]')).not.toBeNull();
    });

    it('says so when nothing changed', async () => {
      await show('a.ts', content({}));
      await click(button('Changes'));
      expect(host.querySelector('[data-testid="file-diff-empty"]')?.textContent).toBe('The agent has not changed this file.');
    });

    it('Tell the agent puts the picked lines and the note into the chat box', async () => {
      const api = fakeApi({ diff: vi.fn(async () => PATCH) }, { 'a.ts': content({}) });
      await show('a.ts', content({}), api);
      await click(button('Changes'));
      const options = [...host.querySelectorAll<HTMLElement>('[data-testid="file-diff"] [role="option"]')];
      const newLine = options.find((o) => o.textContent?.includes('+new'))!;
      const added = options.find((o) => o.textContent?.includes('+added'))!;
      await click(newLine);
      await act(async () => added.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })));
      expect(host.querySelector('[data-testid="tell-bar"]')?.textContent).toContain('2 lines picked');
      const note = host.querySelector<HTMLInputElement>('.ck-ftell-note')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(note, 'Why two lines?');
        note.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await click(button('Tell the agent'));
      expect(takeComposerInserts('p1')).toBe('`a.ts` lines 2-3:\n```diff\n+new\n+added\n```\nWhy two lines?');
      expect(host.querySelector('[data-testid="tell-bar"]')).toBeNull();
      expect(host.querySelector('[role="status"]')?.textContent).toContain('Added to the chat box');
    });

    it('lets the keyboard pick lines with Space', async () => {
      const api = fakeApi({ diff: vi.fn(async () => PATCH) }, { 'a.ts': content({}) });
      await show('a.ts', content({}), api);
      await click(button('Changes'));
      const [hunk, keep] = [...host.querySelectorAll<HTMLElement>('[data-testid="file-diff"] [role="option"]')];
      // The "@@" header says where the lines are; it cannot be picked.
      await act(async () => hunk.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })));
      expect(hunk.getAttribute('aria-selected')).toBe('false');
      expect(host.querySelector('[data-testid="tell-bar"]')).toBeNull();
      await act(async () => keep.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })));
      expect(keep.getAttribute('aria-selected')).toBe('true');
      expect(host.querySelector('[data-testid="tell-bar"]')).not.toBeNull();
    });

    it('has no Tell the agent for a pane without a chat', async () => {
      const api = fakeApi({ diff: vi.fn(async () => PATCH) }, { 'a.ts': content({}) });
      await show('a.ts', content({}), api, false);
      await click(button('Changes'));
      await click(host.querySelector('[data-testid="file-diff"] [role="option"]'));
      expect(host.querySelector('[data-testid="tell-bar"]')).toBeNull();
    });
  });

  it('Tell the agent also works on lines picked in the file view', async () => {
    await show('src/a.ts', content({ path: 'src/a.ts' }));
    await click(button('pick'));
    expect(host.querySelector('[data-testid="tell-bar"]')?.textContent).toContain('2 lines picked');
    await click(button('Tell the agent'));
    expect(takeComposerInserts('p1')).toBe('`src/a.ts` lines 2-3:\n```\nline two\nline three\n```\n');
  });
});
