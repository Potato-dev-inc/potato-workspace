// @vitest-environment jsdom
// The "+" menu of the message box (Add files / folder / image) and the folder chip.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatAttachment } from '../../lib/attachFiles';
import { AttachMenu } from './AttachMenu';
import { AttachmentChips, folderCountText } from './AttachmentChips';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const trigger = () => host.querySelector<HTMLButtonElement>('[data-testid="chat-composer-attach"]')!;
const items = () => [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
const key = (el: Element, k: string) => act(async () => void el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })));

function setup(disabled = false) {
  const cb = { onPickFiles: vi.fn(), onPickFolder: vi.fn(), onPickImage: vi.fn() };
  act(() => root.render(<AttachMenu {...cb} disabled={disabled} />));
  return cb;
}

describe('the + menu', () => {
  it('opens with three choices and runs the one clicked, then closes', async () => {
    const cb = setup();
    expect(items()).toHaveLength(0);
    await act(async () => trigger().click());
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(items().map((b) => b.textContent)).toEqual(['Add files…', 'Add folder…', 'Add image…']);
    await act(async () => items()[1].click());
    expect(cb.onPickFolder).toHaveBeenCalledTimes(1);
    expect(cb.onPickFiles).not.toHaveBeenCalled();
    expect(items()).toHaveLength(0);
    await act(async () => trigger().click());
    await act(async () => items()[2].click());
    expect(cb.onPickImage).toHaveBeenCalledTimes(1);
    await act(async () => trigger().click());
    await act(async () => items()[0].click());
    expect(cb.onPickFiles).toHaveBeenCalledTimes(1);
  });

  it('works from the keyboard: arrows move, Escape closes and returns to the button', async () => {
    setup();
    await act(async () => trigger().click());
    expect(document.activeElement).toBe(items()[0]);
    await key(items()[0], 'ArrowDown');
    expect(document.activeElement).toBe(items()[1]);
    await key(items()[1], 'ArrowUp');
    await key(items()[0], 'ArrowUp');
    expect(document.activeElement).toBe(items()[2]);
    await key(items()[2], 'Escape');
    expect(items()).toHaveLength(0);
    expect(document.activeElement).toBe(trigger());
  });

  it('closes on a click outside, and does nothing while the box cannot take files', async () => {
    setup();
    await act(async () => trigger().click());
    await act(async () => void document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(items()).toHaveLength(0);
    setup(true);
    await act(async () => trigger().click());
    expect(items()).toHaveLength(0);
    expect(trigger().getAttribute('aria-disabled')).toBe('true');
  });
});

describe('the folder chip', () => {
  const folder: ChatAttachment = { name: 'my project', path: 'C:\\work\\my project', kind: 'folder', size: 42, mime: 'inode/directory' };

  it('shows a folder icon, the name and how many files, and can be removed', () => {
    const onRemove = vi.fn();
    act(() => root.render(<AttachmentChips attachments={[folder]} onRemove={onRemove} />));
    const chip = host.querySelector('[data-testid="attachment-chip"]')!;
    expect(chip.getAttribute('data-kind')).toBe('folder');
    expect(chip.querySelector('.ck-att-name')!.textContent).toBe('my project');
    expect(chip.querySelector('.ck-att-meta')!.textContent).toBe('42 files');
    expect(chip.querySelector('.ck-att-file-icon svg path')!.getAttribute('d')).toContain('4l2 2.5');
    act(() => chip.querySelector<HTMLButtonElement>('.ck-att-remove')!.click());
    expect(onRemove).toHaveBeenCalledWith(folder);
  });

  it('words the count plainly', () => {
    expect(folderCountText(1)).toBe('1 file');
    expect(folderCountText(1234)).toBe('1,234 files');
    expect(folderCountText(10_000)).toBe('10,000+ files');
    expect(folderCountText(0)).toBe('Folder');
  });
});
