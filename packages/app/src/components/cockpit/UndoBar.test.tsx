// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetUndoBar, showUndo } from '../../lib/undo-bar';
import { UndoBar } from './UndoBar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<UndoBar />));
});
afterEach(() => {
  act(() => root.unmount());
  resetUndoBar();
  host.remove();
});

const ctrlZ = (target: EventTarget = document.body) => {
  const e = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
};

describe('UndoBar', () => {
  it('renders nothing until something is closed, then the sentence and an Undo button', () => {
    expect(host.querySelector('[data-testid="undo-bar"]')).toBeNull();
    act(() => void showUndo({ text: 'Closed Billing tests', undo: vi.fn() }));
    const bar = host.querySelector('[data-testid="undo-bar"]')!;
    expect(bar.getAttribute('role')).toBe('status');
    expect(bar.textContent).toBe('Closed Billing testsUndo');
  });

  it('the Undo button takes the action back and the bar goes', async () => {
    const undo = vi.fn();
    act(() => void showUndo({ text: 'Closed A', undo }));
    await act(async () => host.querySelector<HTMLButtonElement>('.ck-undobar-btn')!.click());
    expect(undo).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-testid="undo-bar"]')).toBeNull();
  });

  it('Ctrl+Z is Undo while the bar shows', async () => {
    const undo = vi.fn();
    act(() => void showUndo({ text: 'Closed A', undo }));
    let e!: KeyboardEvent;
    await act(async () => {
      e = ctrlZ();
    });
    expect(undo).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it('Ctrl+Z in a text box is left to the text box', async () => {
    const undo = vi.fn();
    act(() => void showUndo({ text: 'Closed A', undo }));
    const box = document.createElement('textarea');
    document.body.appendChild(box);
    await act(async () => {
      ctrlZ(box);
    });
    box.remove();
    expect(undo).not.toHaveBeenCalled();
  });

  it('a bar that only tells has no button and Ctrl+Z does nothing', async () => {
    act(() => void showUndo({ text: 'Could not undo that.' }));
    expect(host.querySelector('.ck-undobar-btn')).toBeNull();
    let e!: KeyboardEvent;
    await act(async () => {
      e = ctrlZ();
    });
    expect(e.defaultPrevented).toBe(false);
  });

  it('is polite for screen readers and never takes focus', () => {
    const before = document.activeElement;
    act(() => void showUndo({ text: 'Closed A', undo: vi.fn() }));
    expect(host.querySelector('[aria-live="polite"]')).not.toBeNull();
    expect(document.activeElement).toBe(before);
  });
});
