// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AskbarApi, AskbarSettings } from '../../../lib/askbar';
import { AskBarSettingsBlock } from './AskBarSettings';

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

const initial: AskbarSettings = {
  enabled: false,
  shortcut: 'Ctrl+Alt+Space',
  default_agent: null,
  last_agent: null,
  attach_clipboard_default: false,
};
const toggle = () => host.querySelector('button[role="switch"]') as HTMLButtonElement;

describe('AskBarSettingsBlock when a save fails', () => {
  it('puts the old value back and says it was not saved', async () => {
    const api = {
      settingsGet: vi.fn(async () => initial),
      settingsSet: vi.fn(async (n: AskbarSettings) => n),
      agents: vi.fn(async () => []),
    };
    api.settingsSet.mockRejectedValueOnce(new Error('disk is full'));
    const onSaved = vi.fn();
    await act(async () => {
      root.render(<AskBarSettingsBlock api={api as unknown as AskbarApi} onSaved={onSaved} />);
    });
    await act(async () => toggle().click());
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    expect(host.querySelector('[role="alert"]')!.textContent).toBe('Not saved: disk is full');
    expect(onSaved).not.toHaveBeenCalled();
    await act(async () => toggle().click());
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(toggle().getAttribute('aria-checked')).toBe('true');
  });
});
