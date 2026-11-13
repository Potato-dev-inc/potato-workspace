// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResizeHandle } from './ResizeHandle';

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

function setup(grow: 'left' | 'right', value = 300) {
  const onChange = vi.fn();
  const onCommit = vi.fn();
  const onReset = vi.fn();
  act(() => root.render(<ResizeHandle value={value} min={200} max={400} grow={grow} label="Resize it" onChange={onChange} onCommit={onCommit} onReset={onReset} />));
  const el = host.querySelector<HTMLElement>('[role="separator"]')!;
  return { el, onChange, onCommit, onReset };
}
const ptr = (el: HTMLElement, type: string, x: number, button = 0) =>
  act(() => void el.dispatchEvent(new MouseEvent(type, { clientX: x, button, bubbles: true, cancelable: true })));
const key = (el: HTMLElement, k: string, init: KeyboardEventInit = {}) =>
  act(() => void el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })));

describe('ResizeHandle', () => {
  it('is a focusable separator that says its size', () => {
    const { el } = setup('right');
    expect(el.tabIndex).toBe(0);
    expect(el.getAttribute('aria-label')).toBe('Resize it');
    expect(el.getAttribute('aria-orientation')).toBe('vertical');
    expect(el.getAttribute('aria-valuenow')).toBe('300');
    expect(el.getAttribute('aria-valuemin')).toBe('200');
    expect(el.getAttribute('aria-valuemax')).toBe('400');
  });
  it('a panel on the left of the handle grows when you drag right', () => {
    const { el, onChange, onCommit } = setup('right');
    ptr(el, 'pointerdown', 100);
    ptr(el, 'pointermove', 140);
    expect(onChange).toHaveBeenLastCalledWith(340);
    ptr(el, 'pointermove', 60);
    expect(onChange).toHaveBeenLastCalledWith(260);
    ptr(el, 'pointerup', 60);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });
  it('a panel on the right of the handle grows when you drag left', () => {
    const { el, onChange } = setup('left');
    ptr(el, 'pointerdown', 500);
    ptr(el, 'pointermove', 450);
    expect(onChange).toHaveBeenLastCalledWith(350);
  });
  it('moving without the button held, or with another button, does nothing', () => {
    const { el, onChange, onCommit } = setup('right');
    ptr(el, 'pointermove', 140);
    ptr(el, 'pointerdown', 100, 2);
    ptr(el, 'pointermove', 140);
    ptr(el, 'pointerup', 140);
    expect(onChange).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });
  it('arrow keys move it 16 px the way the panel grows, Home and End go to the limits, each one saves', () => {
    const r = setup('right');
    key(r.el, 'ArrowRight');
    expect(r.onChange).toHaveBeenLastCalledWith(316);
    key(r.el, 'ArrowLeft');
    expect(r.onChange).toHaveBeenLastCalledWith(284);
    key(r.el, 'Home');
    expect(r.onChange).toHaveBeenLastCalledWith(200);
    key(r.el, 'End');
    expect(r.onChange).toHaveBeenLastCalledWith(400);
    expect(r.onCommit).toHaveBeenCalledTimes(4);
    const l = setup('left');
    key(l.el, 'ArrowLeft');
    expect(l.onChange).toHaveBeenLastCalledWith(316);
  });
  it('leaves keys with a modifier and other keys alone', () => {
    const { el, onChange } = setup('right');
    key(el, 'ArrowRight', { ctrlKey: true });
    key(el, 'a');
    expect(onChange).not.toHaveBeenCalled();
  });
  it('a double-click resets', () => {
    const { el, onReset } = setup('right');
    act(() => void el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    expect(onReset).toHaveBeenCalledTimes(1);
  });
});
