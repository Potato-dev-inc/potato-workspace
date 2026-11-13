// @vitest-environment jsdom
// Proposal 19, the permission chip: first in the row, neutral for safe modes, warning tone with a shield only for
// Full access, changed through the same setConfig as before, and plain text for a conversation open in a terminal.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcpChatState } from '../../lib/acpChat';
import { AcpConfigChips } from './AcpConfigChips';
import { isFullAccessMode } from './permissionChip';

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

const modes = [
  { value: 'ask', name: 'Ask first' },
  { value: 'edits', name: 'Edits allowed' },
  { value: 'bypass', name: 'Full access' },
];
const state = (mode: string, inTerminal = false): AcpChatState =>
  ({
    configOptions: [
      { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'a', options: [{ value: 'a', name: 'Sonnet' }, { value: 'b', name: 'Opus' }] },
      { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: mode, options: modes },
    ],
    turnInFlight: false,
    closed: false,
    inTerminal,
  }) as unknown as AcpChatState;
const chip = () => host.querySelector<HTMLElement>('[data-chip-id="mode"]')!;

describe('permission chip', () => {
  it('comes before the model and is neutral for safe modes', () => {
    act(() => root.render(<AcpConfigChips paneId="p" state={state('ask')} api={{ setConfig: vi.fn() }} />));
    expect([...host.querySelectorAll<HTMLElement>('[data-chip-id]')].map((e) => e.dataset.chipId)).toEqual(['mode', 'model']);
    expect(chip().dataset.tone).toBeUndefined();
    expect(chip().querySelector('.ck-pill-shield')).toBeNull();
  });

  it('is warning-toned with a shield only for Full access', () => {
    act(() => root.render(<AcpConfigChips paneId="p" state={state('bypass')} api={{ setConfig: vi.fn() }} />));
    expect(chip().dataset.tone).toBe('risk');
    expect(chip().querySelector('.ck-pill-shield')).not.toBeNull();
    expect(isFullAccessMode({ value: 'edits', name: 'Edits allowed' })).toBe(false);
  });

  it('changes the mode through the existing setConfig', () => {
    const setConfig = vi.fn().mockResolvedValue(undefined);
    act(() => root.render(<AcpConfigChips paneId="p" state={state('ask')} api={{ setConfig }} />));
    act(() => chip().querySelector<HTMLButtonElement>('button')!.click());
    const opt = [...host.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent?.includes('Full access'))!;
    act(() => opt.click());
    expect(setConfig).toHaveBeenCalledWith('p', 'mode', 'bypass');
  });

  it('is plain text with no list for a conversation open in a terminal', () => {
    act(() => root.render(<AcpConfigChips paneId="p" state={state('bypass', true)} api={{ setConfig: vi.fn() }} />));
    expect(chip().dataset.chipKind).toBe('readonly');
    expect(chip().querySelector('button')).toBeNull();
  });
});
