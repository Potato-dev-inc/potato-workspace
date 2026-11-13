// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { forceShowTerminals, terminalsShown, useShowTerminals } from './showTerminals';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('terminalsShown', () => {
  it('is off for a profile that never touched the setting, and for null or odd values', () => {
    expect(terminalsShown(undefined)).toBe(false);
    expect(terminalsShown(null)).toBe(false);
    expect(terminalsShown({})).toBe(false);
    expect(terminalsShown({ show_terminals: null })).toBe(false);
    expect(terminalsShown({ show_terminals: false, acp_chat_enabled: true })).toBe(false);
  });
  it('is on when the person turned it on', () => {
    expect(terminalsShown({ show_terminals: true })).toBe(true);
  });
  it('stays on while Chat itself is off: nothing else could start', () => {
    expect(terminalsShown({ show_terminals: false, acp_chat_enabled: false })).toBe(true);
  });
});

function Probe() {
  return <span>{String(useShowTerminals())}</span>;
}

describe('useShowTerminals', () => {
  afterEach(() => {
    forceShowTerminals(true);
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    vi.resetModules();
    vi.doUnmock('./settings');
    vi.doUnmock('@tauri-apps/api/event');
  });

  it('a test can force it, and a change reaches a mounted component', async () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    forceShowTerminals(false);
    await act(async () => root.render(<Probe />));
    expect(host.textContent).toBe('false');
    await act(async () => forceShowTerminals(true));
    expect(host.textContent).toBe('true');
    await act(async () => root.unmount());
  });

  it('without a desktop shell and with nothing forced, terminals are shown (there is no setting to read)', async () => {
    forceShowTerminals(null);
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () => root.render(<Probe />));
    expect(host.textContent).toBe('true');
    await act(async () => root.unmount());
  });

  it('in the desktop app it reads the saved setting (off) and follows a change from Settings', async () => {
    (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
    let saved: { show_terminals?: boolean } = {};
    let notify: () => void = () => undefined;
    vi.resetModules();
    vi.doMock('./settings', () => ({ loadSettings: async () => saved }));
    vi.doMock('@tauri-apps/api/event', () => ({
      listen: async (_name: string, fn: () => void) => {
        notify = fn;
        return () => undefined;
      },
    }));
    const fresh = await import('./showTerminals');
    fresh.forceShowTerminals(null);
    function P() {
      return <span>{String(fresh.useShowTerminals())}</span>;
    }
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () => root.render(<P />));
    await act(async () => {});
    expect(host.textContent).toBe('false');
    saved = { show_terminals: true };
    await act(async () => {
      notify();
    });
    await act(async () => {});
    expect(host.textContent).toBe('true');
    await act(async () => root.unmount());
  });
});
