// @vitest-environment jsdom
// The phone's terminal pane: the wrapper loads the xterm view lazily, and the view mounts the terminal session.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgePaneTerminal } from './BridgePaneTerminal';

const seen = vi.hoisted(() => ({ sessions: 0 }));

vi.mock('../hooks/useTerminalSession', async () => {
  const react = await import('react');
  return {
    useTerminalSession: () => {
      seen.sessions += 1;
      const containerRef = react.useRef<HTMLDivElement>(null);
      return { containerRef, afterReclaim: () => {}, isScrolledUp: false, getSelection: () => '' };
    },
  };
});

const pane = { id: 'pane-1', agent_type: 'claude', cols: 80, rows: 24, pid: 42, status: 'idle', created_at: 1 } as never;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('BridgePaneTerminal (phone, lazy xterm view)', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    seen.sessions = 0;
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('shows the pane header and starts the terminal session once the view has loaded', async () => {
    await act(async () => {
      root.render(
        <BridgePaneTerminal
          pane={pane}
          status="idle"
          subscribePaneData={() => () => {}}
          transport={{ resize: () => {}, writeInput: () => {} }}
          title="Claude"
        />,
      );
    });
    // The lazy view resolves on a later tick: wait for it, then check what it rendered.
    for (let i = 0; i < 50 && seen.sessions === 0; i += 1) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
    }
    expect(seen.sessions).toBeGreaterThan(0);
    expect(host.textContent).toContain('Claude');
    expect(host.textContent).toContain('80×24');
  });
});
