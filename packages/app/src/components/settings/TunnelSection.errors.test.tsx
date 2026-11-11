// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TunnelStatus } from '../../lib/tauri-types';
import { TunnelSection, type TunnelApi } from './TunnelSection';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const starting: TunnelStatus = {
  mode: 'quick',
  public_url: null,
  state: 'starting',
  error: null,
  config: { mode: 'quick', hostname: null, url: null, has_token: false },
} as unknown as TunnelStatus;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const api = (getStatus: TunnelApi['getStatus']) => ({ getStatus, save: vi.fn(), restart: vi.fn(), test: vi.fn() }) as unknown as TunnelApi;

describe('TunnelSection errors', () => {
  it('shows a plain error when the first status read fails', async () => {
    await act(async () => root.render(<TunnelSection api={api(vi.fn().mockRejectedValue(new Error('no answer')))} />));
    expect(host.textContent).toContain('Could not read the address: no answer');
  });

  it('shows an error, not an unhandled rejection, when the poll fails', async () => {
    const getStatus = vi.fn().mockResolvedValueOnce(starting).mockRejectedValue(new Error('timed out'));
    await act(async () => root.render(<TunnelSection api={api(getStatus)} />));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    expect(host.textContent).toContain('Could not check the address: timed out');
  });
});
