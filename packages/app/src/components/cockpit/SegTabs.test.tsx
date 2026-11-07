// @vitest-environment jsdom
// The segmented tabs: a mouse click works as before, and Left, Right, Home and End move between the segments
// (one tab stop, on the selected segment).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SegTabs } from './SegTabs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = NoopResizeObserver;

const options = [
  { id: 'a', label: 'Alpha' },
  { id: 'b', label: 'Beta' },
  { id: 'c', label: 'Gamma' },
];

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

const tabs = () => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
const key = (el: HTMLElement, k: string) =>
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  });

describe('SegTabs keyboard and clicks', () => {
  it('a mouse click still selects the segment it is on', async () => {
    const onChange = vi.fn();
    await act(async () => root.render(<SegTabs label="View" options={options} value="a" onChange={onChange} />));
    act(() => tabs()[2].click());
    expect(onChange).toHaveBeenCalledWith('c');
  });

  it('only the selected segment is in the tab order', async () => {
    await act(async () => root.render(<SegTabs label="View" options={options} value="b" onChange={() => {}} />));
    expect(tabs().map((t) => t.tabIndex)).toEqual([-1, 0, -1]);
  });

  it('Right and Left move focus and select, wrapping at the ends', async () => {
    const onChange = vi.fn();
    await act(async () => root.render(<SegTabs label="View" options={options} value="a" onChange={onChange} />));
    key(tabs()[0], 'ArrowRight');
    expect(document.activeElement).toBe(tabs()[1]);
    expect(onChange).toHaveBeenLastCalledWith('b');
    key(tabs()[0], 'ArrowLeft');
    expect(document.activeElement).toBe(tabs()[2]);
    expect(onChange).toHaveBeenLastCalledWith('c');
  });

  it('Home and End jump to the first and last segment', async () => {
    const onChange = vi.fn();
    await act(async () => root.render(<SegTabs label="View" options={options} value="b" onChange={onChange} />));
    key(tabs()[1], 'End');
    expect(document.activeElement).toBe(tabs()[2]);
    expect(onChange).toHaveBeenLastCalledWith('c');
    key(tabs()[2], 'Home');
    expect(document.activeElement).toBe(tabs()[0]);
    expect(onChange).toHaveBeenLastCalledWith('a');
  });

  it('other keys do nothing', async () => {
    const onChange = vi.fn();
    await act(async () => root.render(<SegTabs label="View" options={options} value="a" onChange={onChange} />));
    key(tabs()[0], 'Enter');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('with no segment selected, the first one is the tab stop and no pill is drawn', async () => {
    await act(async () => root.render(<SegTabs label="View" options={options} value={'x' as string} onChange={() => {}} />));
    expect(tabs().map((t) => t.tabIndex)).toEqual([0, -1, -1]);
    expect(host.querySelector('.ck-seg-pill')).toBeNull();
  });
});
