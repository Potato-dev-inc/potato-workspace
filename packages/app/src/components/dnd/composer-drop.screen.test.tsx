// @vitest-environment jsdom
// Screen level: a file dragged from the app's own Changes list and dropped on the chat box becomes a chip (an @
// mention). Files dragged in from Windows still go to the one box under the pointer, through the one shared listener.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { ChatComposer } from '../chat/ChatComposer';
import { ChangesCard } from '../cockpit/rail/ChangesCard';
import { DragLayer } from './DragLayer';
import { cancelDrag } from './dragStore';
import { setFileDropSource, type WindowDropEvent } from '../../lib/fileDrop';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let emit: (e: WindowDropEvent) => void = () => {};

function backend(cmd: string, args?: unknown): unknown {
  const a = (args ?? {}) as Record<string, unknown>;
  if (cmd === 'attachment_prepare') return (a.paths as string[]).map((path) => ({ name: path.split(/[\\/]/).pop(), path, kind: 'text', size: 10 }));
  if (cmd === 'project_files_search') return [{ path: 'src/b.ts', absPath: 'C:/proj/src/b.ts', name: 'b.ts', size: 5 }];
  return null;
}
const rectOf = (l: number, r: number, t: number, b: number) => ({ left: l, right: r, top: t, bottom: b, width: r - l, height: b - t, x: l, y: t, toJSON() {} }) as DOMRect;
const fire = (target: EventTarget, type: string, x: number, y: number) =>
  act(async () => void target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 })));
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const chipNames = () => [...host.querySelectorAll('[data-testid="attachment-chip"]')].map((el) => el.getAttribute('data-name'));

beforeEach(async () => {
  localStorage.clear();
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => backend(cmd, args));
  setFileDropSource(async (cb) => {
    emit = cb;
    return () => undefined;
  });
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
  // The chat box is 0-500 x 300-400 (the form); everything else is empty.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return this.tagName === 'FORM' ? rectOf(0, 500, 300, 400) : rectOf(0, 0, 0, 0);
  });
  await act(async () =>
    root.render(
      <>
        <ChangesCard outputs={[{ path: 'C:/proj/src/a.ts', tool: 'Edit', wrote: true }]} cwd="C:/proj" onOpenChanges={() => {}} />
        <ChatComposer onSend={vi.fn(async () => null)} blockedReason={null} draftKey="pane-1" attachFiles={async () => []} />
        <DragLayer />
      </>,
    ),
  );
  await act(async () => {});
});
afterEach(async () => {
  cancelDrag();
  await act(async () => root.unmount());
  host.remove();
  setFileDropSource(null);
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

describe('drop a changed file on the chat box', () => {
  it('dragging a file from the Changes card onto the box makes a chip', async () => {
    const item = host.querySelector<HTMLElement>('.ck-rail-item')!;
    await fire(item, 'pointerdown', 20, 20);
    await fire(window, 'pointermove', 100, 200);
    await fire(window, 'pointermove', 100, 350);
    expect(host.querySelector('.ck-chat-composer--drop')).not.toBeNull();
    await fire(window, 'pointerup', 100, 350);
    await flush();
    expect(chipNames()).toEqual(['a.ts']);
    expect(host.querySelector('.ck-chat-composer--drop')).toBeNull();
  });

  it('letting go away from the box adds nothing', async () => {
    const item = host.querySelector<HTMLElement>('.ck-rail-item')!;
    await fire(item, 'pointerdown', 20, 20);
    await fire(window, 'pointermove', 100, 100);
    await fire(window, 'pointerup', 100, 100);
    await flush();
    expect(chipNames()).toEqual([]);
  });

  it('a click on the card item still opens Changes and does not drag', async () => {
    const open = vi.fn();
    await act(async () => root.render(<ChangesCard outputs={[{ path: 'C:/proj/src/a.ts', tool: 'Edit', wrote: true }]} cwd="C:/proj" onOpenChanges={open} />));
    const item = host.querySelector<HTMLElement>('.ck-rail-item')!;
    await fire(item, 'pointerdown', 20, 20);
    await fire(window, 'pointermove', 22, 21);
    await fire(window, 'pointerup', 22, 21);
    await act(async () => item.click());
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('Esc cancels the drag: no chip', async () => {
    const item = host.querySelector<HTMLElement>('.ck-rail-item')!;
    await fire(item, 'pointerdown', 20, 20);
    await fire(window, 'pointermove', 100, 350);
    await act(async () => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await fire(window, 'pointerup', 100, 350);
    await flush();
    expect(chipNames()).toEqual([]);
  });
});

describe('files dragged in from Windows', () => {
  it('go to the box under the pointer through the one shared listener', async () => {
    await act(async () => emit({ type: 'drop', paths: ['C:/x/notes.md'], position: { x: 100, y: 350 } }));
    await flush();
    expect(chipNames()).toEqual(['notes.md']);
  });

  it('a drop away from the box adds nothing', async () => {
    await act(async () => emit({ type: 'drop', paths: ['C:/x/notes.md'], position: { x: 100, y: 100 } }));
    await flush();
    expect(chipNames()).toEqual([]);
  });
});
