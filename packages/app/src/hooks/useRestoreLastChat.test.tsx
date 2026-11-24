// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useRestoreLastChat } from './useRestoreLastChat';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe({ listed, openChat }: { listed: string[]; openChat: (k: string) => boolean }) {
  useRestoreLastChat({ open: null, has: (k) => listed.includes(k), openChat });
  return null;
}

describe('restoring the last chat after a restart', () => {
  beforeEach(() => window.localStorage.setItem('pm.lastChat', 'dev:n1:c1'));

  it('opens a far chat once its PC lists it, and only once', async () => {
    const openChat = vi.fn(() => true);
    const el = document.createElement('div');
    const root = createRoot(el);
    await act(async () => root.render(<Probe listed={[]} openChat={openChat} />));
    expect(openChat).not.toHaveBeenCalled();
    await act(async () => root.render(<Probe listed={['dev:n1:c1']} openChat={openChat} />));
    await act(async () => root.render(<Probe listed={['dev:n1:c1']} openChat={openChat} />));
    expect(openChat).toHaveBeenCalledTimes(1);
    expect(openChat).toHaveBeenCalledWith('dev:n1:c1');
    act(() => root.unmount());
  });

  it('gives up quietly once the person clicked something', async () => {
    const openChat = vi.fn(() => true);
    const root = createRoot(document.createElement('div'));
    await act(async () => root.render(<Probe listed={[]} openChat={openChat} />));
    window.dispatchEvent(new Event('pointerdown'));
    await act(async () => root.render(<Probe listed={['dev:n1:c1']} openChat={openChat} />));
    expect(openChat).not.toHaveBeenCalled();
    act(() => root.unmount());
  });
});
