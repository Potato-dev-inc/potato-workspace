// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoopGuardApi, LoopGuardSettings } from '../../../lib/loop-guard';
import { LoopGuardSettingsBlock } from './LoopGuardSettings';

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

const initial = { enabled: true, turns: 4, stalled_minutes: 20, panic_shortcut: false } as unknown as LoopGuardSettings;

describe('LoopGuardSettingsBlock', () => {
  it('saves a change and calls onSaved', async () => {
    const api = { settingsGet: vi.fn(async () => initial), settingsSet: vi.fn(async (n: LoopGuardSettings) => n) };
    const onSaved = vi.fn();
    await act(async () => {
      root.render(<LoopGuardSettingsBlock api={api as unknown as LoopGuardApi} onSaved={onSaved} />);
    });
    await act(async () => (host.querySelector('button[role="switch"]') as HTMLButtonElement).click());
    expect(api.settingsSet).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
    expect(onSaved).toHaveBeenCalled();
  });

  it('puts the old value back and shows the error when the save fails', async () => {
    const api = {
      settingsGet: vi.fn(async () => initial),
      settingsSet: vi.fn(async () => {
        throw new Error('locked');
      }),
    };
    const onSaved = vi.fn();
    await act(async () => {
      root.render(<LoopGuardSettingsBlock api={api as unknown as LoopGuardApi} onSaved={onSaved} />);
    });
    const sw = host.querySelector('button[role="switch"]') as HTMLButtonElement;
    await act(async () => sw.click());
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(host.querySelector('[role="alert"]')!.textContent).toBe('Not saved: locked');
    expect(onSaved).not.toHaveBeenCalled();
  });
});
