// @vitest-environment jsdom
// "Jump to latest" shows only while the reader is above the newest output, and asks the session to go back down.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneData, PaneRegistryApi } from '../hooks/usePaneRegistry';

const probe = vi.hoisted(() => ({ scrolledUp: false }));

vi.mock('../terminal', () => ({
  TerminalSession: class {
    mount() {}
    dispose() {}
    nudgeReflow() {
      return true;
    }
    setReprintsOnResize() {}
    followHeldPty() {}
    afterReclaim() {}
    setKnownPtyGrid() {}
    isScrolledUp() {
      return probe.scrolledUp;
    }
    getSelection() {
      return '';
    }
    setPtyDimensions() {}
    refreshFromSource() {}
    measureFitGrid() {
      return null;
    }
  },
}));
vi.mock('../lib/tauri', () => ({
  tauri: { resize: vi.fn(), writeInput: vi.fn(), reclaimPaneSize: vi.fn(async () => undefined) },
}));
vi.mock('../lib/agentRegistry', () => ({
  agentLabel: (_l: unknown, id: string) => id,
  useAgentRegistry: () => ({}),
}));

import { TerminalViewport } from './TerminalViewport';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pane = {
  status: 'running',
  info: { id: 'p1', agent_type: 'claude', status: 'running', pid: 7, created_at: 11, last_output_at: null, cwd: 'proj', cols: 100, rows: 30 },
} as unknown as PaneData;
const registry = { subscribePaneData: vi.fn(() => () => undefined) } as unknown as PaneRegistryApi;

let host: HTMLDivElement;
let root: Root;
const tick = () => act(async () => { await vi.advanceTimersByTimeAsync(300); });
const pill = () => Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Jump to latest');

beforeEach(async () => {
  vi.useFakeTimers();
  probe.scrolledUp = false;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(<TerminalViewport pane={pane} registry={registry} />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe('Jump to latest', () => {
  it('is hidden at the bottom, shows when scrolled up, and sends the jump event', async () => {
    await tick();
    expect(pill()).toBeUndefined();
    probe.scrolledUp = true;
    await tick();
    expect(pill()).toBeDefined();
    const jumps = vi.fn();
    host.querySelector('.terminal-host')!.addEventListener('pm-terminal-jump-latest', jumps);
    probe.scrolledUp = false; // the session scrolls down when it gets the event
    await act(async () => pill()!.click());
    expect(jumps).toHaveBeenCalledTimes(1);
    expect(pill()).toBeUndefined();
  });
});
