// @vitest-environment jsdom
// The plan bar: counts, the current step, the checklist on a click, the "Done" state that folds, and the thin line
// under a name in the sidebar and on the board (fed by the open chat).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlanLine } from '../common/PlanLine';
import { planProgress, publishPlanProgress } from '../../lib/planProgress';
import type { PlanItem } from '../../lib/sessionChatModel';
import { PLAN_DONE_MS, PlanBar } from './PlanBar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const item = (text: string, status: PlanItem['status']): PlanItem => ({ text, status });
const THREE = [item('Read the code', 'completed'), item('Write the fix', 'in_progress'), item('Run the tests', 'pending')];
const render = (items: PlanItem[]) => act(() => root.render(<PlanBar items={items} />));
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`);

describe('planProgress', () => {
  it('counts done steps and names the one in progress, else the first to do', () => {
    expect(planProgress(THREE)).toEqual({ done: 1, total: 3, current: 'Write the fix', allDone: false });
    expect(planProgress([item('a', 'completed'), item('b', 'pending'), item('c', 'pending')])?.current).toBe('b');
    expect(planProgress([item('a', 'completed')])).toEqual({ done: 1, total: 1, current: null, allDone: true });
    expect(planProgress([])).toBeNull();
  });
});

describe('PlanBar', () => {
  it('says "1 of 3" with the current step and a progress line', () => {
    render(THREE);
    expect(q('plan-bar-count')?.textContent).toBe('1 of 3');
    expect(q('plan-bar-current')?.textContent).toBe('· Write the fix');
    const line = host.querySelector('[role="progressbar"]')!;
    expect(line.getAttribute('aria-valuenow')).toBe('1');
    expect(line.getAttribute('aria-valuemax')).toBe('3');
    expect(q('plan-bar-list')).toBeNull();
  });

  it('opens the checklist on a click and folds it on the next', () => {
    render(THREE);
    const head = host.querySelector('button')!;
    act(() => head.click());
    expect(head.getAttribute('aria-expanded')).toBe('true');
    expect([...host.querySelectorAll('li')].map((li) => li.getAttribute('data-status'))).toEqual(['completed', 'in_progress', 'pending']);
    expect(host.querySelector('[aria-label="Done"]')).not.toBeNull();
    act(() => head.click());
    expect(q('plan-bar-list')).toBeNull();
  });

  it('follows the list as steps finish', () => {
    render(THREE);
    render([item('Read the code', 'completed'), item('Write the fix', 'completed'), item('Run the tests', 'in_progress')]);
    expect(q('plan-bar-count')?.textContent).toBe('2 of 3');
    expect(q('plan-bar-current')?.textContent).toBe('· Run the tests');
  });

  it('reads "Done · 3 of 3" when every step is done, then folds away', () => {
    render(THREE);
    render(THREE.map((s) => ({ ...s, status: 'completed' as const })));
    expect(q('plan-bar-count')?.textContent).toBe('Done · 3 of 3');
    expect(q('plan-bar-current')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(PLAN_DONE_MS + 10);
    });
    expect(q('plan-bar')).toBeNull();
  });

  it('comes back when a new step is added after it folded', () => {
    render([item('a', 'completed')]);
    act(() => {
      vi.advanceTimersByTime(PLAN_DONE_MS + 10);
    });
    expect(q('plan-bar')).toBeNull();
    render([item('a', 'completed'), item('b', 'pending')]);
    expect(q('plan-bar-count')?.textContent).toBe('1 of 2');
  });

  it('does not show a list that was already finished when the chat opened, and shows nothing without a list', () => {
    render([item('a', 'completed'), item('b', 'completed')]);
    expect(q('plan-bar')).toBeNull();
    render([]);
    expect(q('plan-bar')).toBeNull();
  });
});

describe('PlanLine (sidebar row and board tile)', () => {
  it('draws a thin line from what the open chat published, and nothing when there is no list or it is done', () => {
    act(() => root.render(<PlanLine paneId="pl-1" />));
    expect(q('plan-line')).toBeNull();
    act(() => publishPlanProgress('pl-1', planProgress(THREE)));
    const line = q('plan-line')!;
    expect(line.getAttribute('aria-valuenow')).toBe('1');
    expect(line.getAttribute('title')).toBe('1 of 3 · Write the fix');
    expect((line.firstElementChild as HTMLElement).style.width).toBe('33%');
    act(() => publishPlanProgress('pl-1', planProgress(THREE.map((s) => ({ ...s, status: 'completed' as const })))));
    expect(q('plan-line')).toBeNull();
    act(() => publishPlanProgress('pl-1', null));
  });
});
