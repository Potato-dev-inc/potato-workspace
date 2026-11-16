// @vitest-environment jsdom
// Settings > Agents: "Tell me when an agent is stuck" saves the minutes (0 = off).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEnglish } from '../../../i18n/test-utils';
import { StuckHelperMinutes } from './HelperAgents';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  useEnglish();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('Stuck helper minutes', () => {
  it('shows the saved value and saves a change', async () => {
    const api = { get: vi.fn(async () => ({ value: 5 })), set: vi.fn(async (value: number) => ({ value })) };
    const saved = vi.fn();
    await act(async () => root.render(<StuckHelperMinutes api={api} onSaved={saved} />));
    await act(async () => {});
    const select = host.querySelector<HTMLSelectElement>('select')!;
    expect(select.value).toBe('5');
    expect(host.textContent).toContain('Tell me when an agent is stuck');
    expect([...select.options].map((o) => o.textContent)).toContain('Off');
    await act(async () => {
      select.value = '1';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(api.set).toHaveBeenCalledWith(1);
    expect(saved).toHaveBeenCalled();
  });
});
