// @vitest-environment jsdom
// Screen level: a file dropped on a terminal pane is typed at the prompt, in quotes when it needs them, and Enter
// is never pressed. Works for a file dragged in from Windows and for a file dragged from the Changes list.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneData, PaneRegistryApi } from '../../hooks/usePaneRegistry';

const write = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('../../terminal', () => ({
  TerminalSession: class {
    mount() {}
    dispose() {}
    nudgeReflow() {
      return true;
    }
    setReprintsOnResize() {}
    followHeldPty() {}
    afterReclaim() {}
    setKnownPtyGrid() {}
    isScrolledUp() {
      return false;
    }
    getSelection() {
      return '';
    }
    setPtyDimensions() {}
    refreshFromSource() {}
    measureFitGrid() {
      return null;
    }
  },
}));
vi.mock('../../lib/tauri', () => ({
  tauri: { resize: vi.fn(), writeInput: write, reclaimPaneSize: vi.fn(async () => undefined) },
}));
vi.mock('../../lib/agentRegistry', () => ({
  agentLabel: (_l: unknown, id: string) => id,
  useAgentRegistry: () => ({}),
}));

import { TerminalViewport } from '../TerminalViewport';
import { DragLayer } from './DragLayer';
import { cancelDrag, startDrag } from './dragStore';
import { setFileDropSource, type WindowDropEvent } from '../../lib/fileDrop';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pane = {
  status: 'running',
  info: { id: 'p1', agent_type: 'claude', status: 'running', pid: 7, created_at: 11, last_output_at: null, cwd: 'proj', cols: 100, rows: 30 },
} as unknown as PaneData;
const registry = { subscribePaneData: vi.fn(() => () => undefined) } as unknown as PaneRegistryApi;

let host: HTMLDivElement;
let root: Root;
let emit: (e: WindowDropEvent) => void = () => {};

beforeEach(async () => {
  write.mockClear();
  setFileDropSource(async (cb) => {
    emit = cb;
    return () => undefined;
  });
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
  // The pane is the box 0-500 x 0-400.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const on = this.tagName === 'SECTION';
    return { left: 0, right: on ? 500 : 0, top: 0, bottom: on ? 400 : 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} } as DOMRect;
  });
  await act(async () =>
    root.render(
      <>
        <TerminalViewport pane={pane} registry={registry} />
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
  vi.restoreAllMocks();
});

describe('drop a file on a terminal pane', () => {
  it('types the path at the prompt, and never presses Enter', async () => {
    await act(async () => emit({ type: 'drop', paths: ['C:\\work\\a.txt'], position: { x: 100, y: 100 } }));
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('p1', 'C:\\work\\a.txt ', false);
  });

  it('puts quotes around a path with a space', async () => {
    await act(async () => emit({ type: 'drop', paths: ['C:\\My Files\\a b.txt'], position: { x: 100, y: 100 } }));
    expect(write).toHaveBeenCalledWith('p1', '"C:\\My Files\\a b.txt" ', false);
  });

  it('several files are typed one after another on the same line', async () => {
    await act(async () => emit({ type: 'drop', paths: ['C:\\a.txt', 'C:\\b c.txt'], position: { x: 100, y: 100 } }));
    expect(write).toHaveBeenCalledWith('p1', 'C:\\a.txt "C:\\b c.txt" ', false);
  });

  it('a drop outside the pane types nothing', async () => {
    await act(async () => emit({ type: 'drop', paths: ['C:\\a.txt'], position: { x: 900, y: 100 } }));
    expect(write).not.toHaveBeenCalled();
  });

  it('outlines the pane while a file is over it', async () => {
    await act(async () => emit({ type: 'over', position: { x: 100, y: 100 } }));
    expect(host.querySelector('section')?.getAttribute('data-file-over')).toBe('true');
    await act(async () => emit({ type: 'leave' }));
    expect(host.querySelector('section')?.getAttribute('data-file-over')).toBeNull();
  });

  it('a file dragged from the Changes list is typed too', async () => {
    const fire = (type: string, x: number, y: number) =>
      act(async () => void window.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 })));
    startDrag({ kind: 'file', id: 'src/a b.ts', label: 'a b.ts', meta: { abs: 'C:\\proj\\src\\a b.ts' } }, { clientX: 700, clientY: 10, button: 0 });
    await fire('pointermove', 400, 100);
    await fire('pointermove', 200, 100);
    await fire('pointerup', 200, 100);
    await act(async () => {});
    expect(write).toHaveBeenCalledWith('p1', '"C:\\proj\\src\\a b.ts" ', false);
  });
});
