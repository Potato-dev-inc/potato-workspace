// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FilesCard, absolutePath } from './FilesCard';
import { fakeApi } from './fakes';
import { resetFileTabs, usePaneFiles } from '../../lib/file-tabs';
import { resetComposerInserts, takeComposerInserts } from '../../lib/composer-insert';
import { useEnglish } from '../../i18n/test-utils';

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
  resetFileTabs();
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
const names = () => [...host.querySelectorAll('[role="treeitem"] .ck-ftree-name')].map((e) => e.textContent);
const row = (path: string) => host.querySelector<HTMLButtonElement>(`[data-path="${path}"]`)!;

function OpenFiles({ paneId }: { paneId: string }) {
  return <output data-testid="open">{usePaneFiles(paneId).files.join(',')}</output>;
}

async function show(api = fakeApi(), search = vi.fn(async () => [] as never[])) {
  await act(async () =>
    root.render(
      <>
        <FilesCard paneId="p1" cwd={'C:\\work\\shop'} api={api} search={search} />
        <OpenFiles paneId="p1" />
      </>,
    ),
  );
  await flush();
  return { api, search };
}

describe('Files card', () => {
  it('lists the top folder with folders first, and reads a folder only when it is opened', async () => {
    const { api } = await show();
    expect(names()).toEqual(['src', 'docs', 'README.md', 'logo.png']);
    expect(api.list).toHaveBeenCalledTimes(1);
    await act(async () => row('src').click());
    await flush();
    expect(api.list).toHaveBeenCalledWith('p1', 'src');
    expect(names()).toEqual(['src', 'app.ts', 'new.ts', 'docs', 'README.md', 'logo.png']);
    expect(row('src').getAttribute('aria-expanded')).toBe('true');
    await act(async () => row('src').click());
    expect(names()).toEqual(['src', 'docs', 'README.md', 'logo.png']);
  });

  it('marks changed and new files, and a folder that holds changes', async () => {
    await show();
    await act(async () => row('src').click());
    await flush();
    expect(row('src/app.ts').querySelector('[data-mark="M"]')?.getAttribute('aria-label')).toBe('Changed');
    expect(row('src/new.ts').querySelector('[data-mark="N"]')?.getAttribute('aria-label')).toBe('New');
    expect(row('src').querySelector('.ck-ftree-dot')).not.toBeNull();
    expect(row('docs').querySelector('.ck-ftree-dot')).toBeNull();
  });

  it('opens a file in a tab when it is clicked', async () => {
    await show();
    await act(async () => row('src').click());
    await flush();
    await act(async () => row('src/app.ts').click());
    expect(host.querySelector('[data-testid="open"]')?.textContent).toBe('src/app.ts');
  });

  it('moves with the arrow keys and opens or closes folders', async () => {
    await show();
    await act(async () => {
      row('src').focus();
      row('src').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    await flush();
    expect(row('src').getAttribute('aria-expanded')).toBe('true');
    await act(async () => row('src').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    expect(document.activeElement).toBe(row('src/app.ts'));
    await act(async () => row('src/app.ts').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })));
    expect(document.activeElement).toBe(row('src'));
  });

  it('finds files by name anywhere in the project with the filter box', async () => {
    const search = vi.fn(async () => [{ path: 'docs/guide.md', absPath: 'x', name: 'guide.md', size: 3 }]);
    await show(fakeApi(), search as never);
    const input = host.querySelector<HTMLInputElement>('[data-testid="files-filter"]')!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(input, 'gui');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 250));
    });
    expect(search).toHaveBeenCalledWith('p1', 'gui', 50);
    const hit = host.querySelector<HTMLButtonElement>('[data-testid="files-hits"] button')!;
    expect(hit.textContent).toContain('guide.md');
    await act(async () => hit.click());
    expect(host.querySelector('[data-testid="open"]')?.textContent).toBe('docs/guide.md');
  });

  describe('right-click menu', () => {
    const menu = () => [...document.querySelectorAll('[role="menuitem"]')] as HTMLButtonElement[];
    const pick = (label: string) => menu().find((b) => b.textContent === label)!;
    const rightClick = async (path: string) => {
      await act(async () => {
        row(path).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      });
    };

    it('offers Copy path, Show in Explorer, Open in editor and Mention in chat', async () => {
      await show();
      await rightClick('README.md');
      expect(menu().map((b) => b.textContent)).toEqual(['Open', 'Copy path', 'Show in Explorer', 'Open in editor', 'Mention in chat']);
    });

    it('Copy path copies the full path', async () => {
      const writeText = vi.fn(async () => undefined);
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      await show();
      await rightClick('README.md');
      await act(async () => pick('Copy path').click());
      expect(writeText).toHaveBeenCalledWith('C:\\work\\shop\\README.md');
    });

    it('Show in Explorer asks the backend', async () => {
      const { api } = await show();
      await rightClick('README.md');
      await act(async () => pick('Show in Explorer').click());
      expect(api.reveal).toHaveBeenCalledWith('p1', 'README.md');
    });

    it('Mention in chat puts @path in the pane message box', async () => {
      await show();
      await rightClick('README.md');
      await act(async () => pick('Mention in chat').click());
      expect(takeComposerInserts('p1')).toBe('@README.md ');
    });

    it('opens with the menu key from the keyboard', async () => {
      await show();
      await act(async () => {
        row('README.md').dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true, cancelable: true }));
      });
      expect(menu().length).toBe(5);
    });
  });

  it('says why when the folder cannot be read', async () => {
    await show(fakeApi({ list: vi.fn(async () => Promise.reject(new Error('FILES_NO_ROOT: The project folder is not there.'))) }));
    expect(host.querySelector('[role="alert"]')?.textContent).toBeTruthy();
  });
});

describe('absolutePath', () => {
  it('keeps the style of the project folder', () => {
    expect(absolutePath('C:\\work\\shop\\', 'src/a.ts')).toBe('C:\\work\\shop\\src\\a.ts');
    expect(absolutePath('/home/me/shop', 'src/a.ts')).toBe('/home/me/shop/src/a.ts');
  });
});
