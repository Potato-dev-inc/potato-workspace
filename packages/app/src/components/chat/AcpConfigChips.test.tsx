// @vitest-environment jsdom
// Which control a setting gets: an effort-like setting (category thought_level) with four choices or fewer is a
// segmented switch; every other setting, and a longer effort list, is a menu. Decided by category and count only.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcpChatState } from '../../lib/acpChat';
import { AcpConfigChips } from './AcpConfigChips';

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

const select = (id: string, category: string, values: string[]) => ({
  id,
  name: id[0].toUpperCase() + id.slice(1),
  category,
  type: 'select',
  currentValue: values[0],
  options: values.map((v) => ({ value: v, name: v.toUpperCase() })),
});
const state = (configOptions: unknown[]): AcpChatState => ({ configOptions, turnInFlight: false, closed: false, inTerminal: false }) as unknown as AcpChatState;
const kinds = () => [...host.querySelectorAll<HTMLElement>('[data-chip-id]')].map((el) => `${el.dataset.chipId}:${el.dataset.chipKind}`);

describe('AcpConfigChips', () => {
  it('uses a segmented switch for an effort-like setting with few choices, menus for the rest', () => {
    const options = [select('model', 'model', ['a', 'b', 'c']), select('mode', 'mode', ['x', 'y']), select('effort', 'thought_level', ['low', 'medium', 'high'])];
    act(() => root.render(<AcpConfigChips paneId="p1" state={state(options)} api={{ setConfig: vi.fn() }} />));
    expect(kinds()).toEqual(['mode:menu', 'model:menu', 'effort:segmented']);
  });

  it('keeps a menu for an effort-like setting with more than four choices, and for a few-choice setting of another kind', () => {
    const options = [select('effort', 'thought_level', ['a', 'b', 'c', 'd', 'e']), select('mode', 'mode', ['x', 'y'])];
    act(() => root.render(<AcpConfigChips paneId="p1" state={state(options)} api={{ setConfig: vi.fn() }} />));
    expect(kinds()).toEqual(['mode:menu', 'effort:menu']);
  });

  it('sends the pick to the backend with the same call as before', async () => {
    const setConfig = vi.fn(async () => state([]));
    act(() => root.render(<AcpConfigChips paneId="p1" state={state([select('effort', 'thought_level', ['low', 'high'])])} api={{ setConfig }} />));
    act(() => host.querySelectorAll<HTMLButtonElement>('[role="radio"]')[1].click());
    expect(setConfig).toHaveBeenCalledWith('p1', 'effort', 'high');
    expect(host.querySelector<HTMLElement>('[data-chip-id]')!.dataset.value).toBe('high');
  });
});
