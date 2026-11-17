// @vitest-environment jsdom
// The own-domain help shows the port this running app really serves (never a fixed 1420), with a copy button.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLanguagePref } from '../../i18n';
import type { TunnelStatus } from '../../lib/tauri-types';
import { TunnelSection, type TunnelApi } from './TunnelSection';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const base = (mode: 'named' | 'custom', extra: Partial<TunnelStatus>): TunnelStatus => ({
  mode,
  public_url: 'https://pm.example.com',
  state: 'running',
  error: null,
  config: { mode, hostname: mode === 'named' ? 'pm.example.com' : null, url: mode === 'custom' ? 'https://pm.example.com' : null, has_token: mode === 'named' },
  ...extra,
});

describe('TunnelSection own-domain address', () => {
  let host: HTMLDivElement;
  let root: Root;
  const writeText = vi.fn(async () => undefined);
  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    writeText.mockClear();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    setLanguagePref('en', false);
  });
  const show = async (status: TunnelStatus) => {
    const api: TunnelApi = {
      getStatus: vi.fn(async () => status),
      save: vi.fn(async () => status),
      restart: vi.fn(async () => status),
      test: vi.fn(),
    };
    await act(async () => root.render(<TunnelSection api={api} />));
    await act(async () => { await Promise.resolve(); });
  };

  it.each(['named', 'custom'] as const)('%s: shows the real port, not 1420, and copies it', async (mode) => {
    await show(base(mode, { local_port: 1473 }));
    expect(host.querySelector('[data-testid="tunnel-local-url"]')?.textContent).toBe('http://127.0.0.1:1473');
    expect(host.textContent).not.toContain('1420');
    await act(async () => (host.querySelector('[data-testid="tunnel-local-copy"]') as HTMLButtonElement).click());
    expect(writeText).toHaveBeenCalledWith('http://127.0.0.1:1473');
    expect(host.querySelector('[data-testid="tunnel-local-moved"]')).toBeNull();
  });

  it('says plainly when the phone server is not running', async () => {
    await show(base('custom', { local_port: null, port_problem: 'not_running' }));
    expect(host.querySelector('[data-testid="tunnel-local-url"]')).toBeNull();
    expect(host.querySelector('[data-testid="tunnel-local-missing"]')?.textContent).toMatch(/not running/);
  });

  it('warns when the usual port was taken and another is used', async () => {
    await show(base('named', { local_port: 1480, port_problem: 'moved' }));
    expect(host.querySelector('[data-testid="tunnel-local-moved"]')?.textContent).toMatch(/another program/);
  });

  it('shows the same in Traditional Chinese', async () => {
    setLanguagePref('zh-TW', false);
    await show(base('custom', { local_port: 1473, port_problem: 'moved' }));
    expect(host.querySelector('[data-testid="tunnel-local"]')?.textContent).toContain('把你的網域指向');
    expect(host.querySelector('[data-testid="tunnel-local-url"]')?.textContent).toBe('http://127.0.0.1:1473');
    expect(host.querySelector('[data-testid="tunnel-local-copy"]')?.textContent).toBe('複製這個位址');
    expect(host.querySelector('[data-testid="tunnel-local-moved"]')?.textContent).toContain('連接埠');
    expect(host.textContent).not.toContain('1420');
  });
});
