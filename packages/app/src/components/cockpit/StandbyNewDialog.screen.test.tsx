// @vitest-environment jsdom
// The "New standby helper" sheet: opened by the event the bar and the New agent menu send, and by the What's new
// "Try it" action `standby.new`; it makes a standby and closes; at the limit it says so and cannot add.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openNewStandby, type StandbyHelpersApi, type StandbyHelpersView } from '../../lib/standbyHelpers';
import { runAction } from '../../whatsnew/registry';
import { StandbyNewDialog } from './StandbyNewDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const view = (n: number, max = 4): StandbyHelpersView => ({
  max,
  idle_minutes: 30,
  helpers: Array.from({ length: n }, (_, i) => ({ id: `s${i}`, name: `H${i}`, agent: 'codex', model: null, project: '/p', after_task: 'wait' as const, state: 'ready' as const, note: null, pane_id: null })),
});

let host: HTMLDivElement;
let root: Root;
let current: StandbyHelpersView;
const api: StandbyHelpersApi = {
  get: vi.fn(async () => current),
  add: vi.fn(async () => view(1)),
  update: vi.fn(async () => current),
  remove: vi.fn(async () => current),
  start: vi.fn(async () => current),
  setLimits: vi.fn(async () => current),
};

const mount = async () => {
  await act(async () => root.render(<StandbyNewDialog api={api} />));
  await act(async () => {});
};
const dialog = () => host.querySelector('[data-testid="standby-dialog"]');
const input = (label: string) => host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
const typeInto = async (el: HTMLInputElement, v: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });

beforeEach(() => {
  current = view(0);
  vi.clearAllMocks();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('New standby helper sheet', () => {
  it('is closed until asked, then opens with the folder it was given', async () => {
    await mount();
    expect(dialog()).toBeNull();
    await act(async () => openNewStandby('C:/work/shop'));
    expect(dialog()).not.toBeNull();
    expect(input('Project folder').value).toBe('C:/work/shop');
    expect(host.textContent).toContain('New standby helper');
  });

  it('opens from the What\'s new action standby.new', async () => {
    await mount();
    let result = '';
    await act(async () => {
      result = runAction('standby.new');
    });
    expect(result).toBe('done');
    expect(dialog()).not.toBeNull();
  });

  it('makes the standby and closes', async () => {
    await mount();
    await act(async () => openNewStandby('/p'));
    await typeInto(input('Name'), 'Reviewer');
    await act(async () => {
      [...host.querySelectorAll('button')].find((b) => b.textContent === 'Add standby')!.click();
    });
    await act(async () => {});
    expect(api.add).toHaveBeenCalledWith(expect.objectContaining({ name: 'Reviewer', project: '/p' }));
    expect(dialog()).toBeNull();
  });

  it('Cancel closes it without making anything', async () => {
    await mount();
    await act(async () => openNewStandby('/p'));
    await act(async () => {
      [...host.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!.click();
    });
    expect(dialog()).toBeNull();
    expect(api.add).not.toHaveBeenCalled();
  });

  it('at the limit it says so and Add is off', async () => {
    current = view(2, 2);
    await mount();
    await act(async () => {});
    await act(async () => openNewStandby('/p'));
    expect(host.textContent).toContain('You have 2 standbys, the most allowed.');
    expect([...host.querySelectorAll('button')].find((b) => b.textContent === 'Add standby')!.disabled).toBe(true);
  });
});
