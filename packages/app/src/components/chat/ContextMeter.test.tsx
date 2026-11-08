// @vitest-environment jsdom
// The context ring: shows the share used, opens a small popover with the numbers, hides when there is no reading.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContextReading } from '../cockpit/rail/railFormat';
import { ContextMeter } from './ContextMeter';

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

const reading = (over: Partial<ContextReading> = {}): ContextReading => ({ used: 41_000, window: 200_000, percent: 21, input: 40_000, output: 1000, ...over });
const ring = () => host.querySelector<HTMLButtonElement>('.ck-ctx-ring')!;
const pop = () => host.querySelector<HTMLElement>('[data-testid="context-meter-pop"]');

describe('ContextMeter', () => {
  it('draws nothing without a reading', () => {
    act(() => root.render(<ContextMeter reading={null} />));
    expect(host.innerHTML).toBe('');
  });

  it('names the percent on the ring and fills the arc to match', () => {
    act(() => root.render(<ContextMeter reading={reading({ percent: 25 })} />));
    expect(ring().getAttribute('aria-label')).toBe('Context 25% used');
    const fg = host.querySelector('.ck-ctx-fg')!;
    const full = Number(fg.getAttribute('stroke-dasharray'));
    expect(Number(fg.getAttribute('stroke-dashoffset'))).toBeCloseTo(full * 0.75, 3);
  });

  it('is a static gauge: a track and an arc, the percent in the tooltip, nothing animated', () => {
    act(() => root.render(<ContextMeter reading={reading({ percent: 62 })} />));
    expect(ring().title).toBe('Context 62% used');
    expect(host.querySelector('.ck-ctx-bg')).not.toBeNull();
    expect(host.querySelector('.ck-ctx-fg')).not.toBeNull();
    expect(host.querySelector('animate, animateTransform')).toBeNull();
  });

  it('opens a popover with the tokens and a thin bar, and Esc closes it and returns the focus', () => {
    act(() => root.render(<ContextMeter reading={reading()} />));
    expect(pop()).toBeNull();
    act(() => ring().click());
    expect(ring().getAttribute('aria-expanded')).toBe('true');
    expect(pop()!.textContent).toContain('Used 41k of 200k tokens');
    expect(pop()!.querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow')).toBe('21');
    act(() => {
      pop()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(pop()).toBeNull();
    expect(document.activeElement).toBe(ring());
  });

  it('closes on a press outside', () => {
    act(() => root.render(<ContextMeter reading={reading()} />));
    act(() => ring().click());
    act(() => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(pop()).toBeNull();
  });
});
