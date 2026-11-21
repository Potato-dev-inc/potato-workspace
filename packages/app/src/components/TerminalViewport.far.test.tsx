// @vitest-environment jsdom
// P2.3: the SAME TerminalViewport draws a terminal that runs on another PC. The pane registry is built over a (fake) far host: the
// far PC's output arrives as `terminal-data` frames and its screen replay as a `call/`; keys and resizes go back as `call/`s.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePaneRegistry, type PaneData, type PaneRegistryApi } from '../hooks/usePaneRegistry';
import { ALL_CAPS, type Host } from '../lib/host/host';

const probe = vi.hoisted(() => ({ written: [] as string[], onInput: null as null | ((text: string, newline?: boolean) => void), onResize: null as null | ((cols: number, rows: number) => void), grids: [] as Array<[number, number]> }));

vi.mock('../terminal', () => ({
  TerminalSession: class {
    constructor(options: { onInput: typeof probe.onInput; onResize: typeof probe.onResize }) {
      probe.onInput = options.onInput;
      probe.onResize = options.onResize;
    }
    mount(_: HTMLElement, subscribe: (id: string, cb: (b: Uint8Array) => void, onResize: (c: number, r: number) => void) => () => void) {
      subscribe('p1', (bytes) => probe.written.push(new TextDecoder().decode(bytes)), (cols, rows) => probe.grids.push([cols, rows]));
    }
    dispose() {}
    nudgeReflow() {
      return true;
    }
    setReprintsOnResize() {}
    followHeldPty() {}
    afterReclaim() {}
    setKnownPtyGrid() {}
    isScrolledUp() {
      return false;
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
vi.mock('../lib/tauri', () => ({ tauri: { resize: vi.fn(), writeInput: vi.fn(), reclaimPaneSize: vi.fn(async () => undefined) } }));
vi.mock('../lib/agentRegistry', () => ({ agentLabel: (_l: unknown, id: string) => id, useAgentRegistry: () => ({}) }));

import { TerminalViewport } from './TerminalViewport';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const b64 = (text: string) => btoa(text);
const bytes = (text: string) => Array.from(new TextEncoder().encode(text));

/** A far PC: its commands (recorded) and the events it pushes. */
function farPc() {
  const calls: Array<{ cmd: string; args: unknown }> = [];
  const listeners = new Map<string, Array<(payload: unknown) => void>>();
  const host: Host = {
    place: { kind: 'pc', node: 'aa', name: 'Linux box' },
    live: true,
    caps: ALL_CAPS,
    invoke: async <T,>(cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      if (cmd === 'read_pane_screen_replay') return { data: bytes('$ uname -a\r\n'), cols: 90, rows: 28, offset: 12 } as T;
      if (cmd === 'list_panes') return [] as T;
      return undefined as T;
    },
    listen: async <T,>(event: string, cb: (payload: T) => void) => {
      const list = listeners.get(event) ?? [];
      list.push(cb as (payload: unknown) => void);
      listeners.set(event, list);
      return () => listeners.set(event, (listeners.get(event) ?? []).filter((c) => c !== cb));
    },
  };
  return { host, calls, emit: (event: string, payload: unknown) => (listeners.get(event) ?? []).forEach((cb) => cb(payload)), count: (cmd: string) => calls.filter((c) => c.cmd === cmd).length };
}

const pane: PaneData = { status: 'idle', info: { id: 'p1', agent_type: 'bash', pid: 0, status: 'idle', created_at: 0, last_output_at: null, cwd: '/home/pm/app', cols: 90, rows: 28 } };

let box: HTMLDivElement;
let root: Root;
const settle = () => act(async () => void (await vi.advanceTimersByTimeAsync(50)));

beforeEach(() => {
  vi.useFakeTimers();
  probe.written.length = 0;
  probe.grids.length = 0;
  box = document.createElement('div');
  document.body.appendChild(box);
  root = createRoot(box);
});
afterEach(() => {
  act(() => root.unmount());
  box.remove();
  vi.useRealTimers();
});

let registryOf: PaneRegistryApi | null = null;
function Far({ host }: { host: Host }) {
  const registry = usePaneRegistry(host);
  registryOf = registry;
  return <TerminalViewport pane={pane} registry={registry} chrome={false} />;
}

async function open(far: ReturnType<typeof farPc>) {
  await act(async () => root.render(<Far host={far.host} />));
  await settle();
}

describe('TerminalViewport over a far PC', () => {
  it('draws the far screen first, then the far output as it arrives, sized to the far grid', async () => {
    const far = farPc();
    await open(far);
    expect(far.count('read_pane_screen_replay')).toBe(1);
    expect(probe.written.join('')).toBe('$ uname -a\r\n');
    expect(probe.grids).toContainEqual([90, 28]);
    await act(async () => far.emit('terminal-data', { pane_id: 'p1', b64: b64('Linux pm-sbx 6.6 x86_64\r\n'), offset: 12 }));
    expect(probe.written.join('')).toContain('Linux pm-sbx 6.6 x86_64');
    // The far PC's resize reaches the viewer in order.
    await act(async () => far.emit('pty://resized', { pane_id: 'p1', cols: 120, rows: 40 }));
    expect(probe.grids.at(-1)).toEqual([120, 40]);
  });

  it('sends what is typed and the grid it fits to the far PC, as calls, and never to this PC', async () => {
    const far = farPc();
    await open(far);
    await act(async () => probe.onInput!('htop\r', false));
    await act(async () => probe.onResize!(100, 30));
    expect(far.calls).toContainEqual({ cmd: 'write_pane_input', args: { paneId: 'p1', args: { text: 'htop\r', append_newline: false } } });
    expect(far.calls).toContainEqual({ cmd: 'resize_pane', args: { paneId: 'p1', cols: 100, rows: 30 } });
  });

  it('draws the screen again from the far PC when output went missing (a gap, or the far PC said it dropped some)', async () => {
    const far = farPc();
    await open(far);
    // A chunk that starts past where the last one ended: bytes were lost on the way.
    await act(async () => far.emit('terminal-data', { pane_id: 'p1', b64: b64('late'), offset: 5000 }));
    await settle();
    expect(far.count('read_pane_screen_replay')).toBe(2);
    expect(probe.written).toContain('\u001bc');
    // The far PC's own "I dropped output" note: one redraw a moment later, not one per note.
    await act(async () => {
      far.emit('terminal-lag', { pane_id: 'p1' });
      far.emit('terminal-lag', { pane_id: 'p1' });
      await vi.advanceTimersByTimeAsync(700);
    });
    expect(far.count('read_pane_screen_replay')).toBe(3);
  });

  it("does not take the far PC's echo of its own resize as news, but follows another viewer's", async () => {
    const far = farPc();
    await open(far);
    await act(async () => probe.onResize!(100, 30));
    probe.grids.length = 0;
    await act(async () => far.emit('pty://resized', { pane_id: 'p1', cols: 100, rows: 30 }));
    expect(probe.grids).toEqual([]);
    await act(async () => far.emit('pty://resized', { pane_id: 'p1', cols: 70, rows: 20, offset: null }));
    expect(probe.grids).toEqual([[70, 20]]);
  });

  it('a place below Full asks for no list, screen, keys or sizes (the far PC would refuse them)', async () => {
    const far = farPc();
    far.host.caps = { ...ALL_CAPS, terminal: false };
    await open(far);
    expect(far.count('list_panes')).toBe(0);
    await act(async () => probe.onInput!('ls', false));
    await act(async () => probe.onResize!(100, 30));
    expect(far.count('write_pane_input') + far.count('resize_pane')).toBe(0);
    // Screen and output are Full only (they may hold secrets): nothing is asked, nothing is drawn.
    expect(far.count('read_pane_screen_replay') + far.count('read_pane_raw_buffer')).toBe(0);
    expect(probe.written.join('')).toBe('');
  });

  it("a new terminal on a far project is the far PC's login shell, by spawn_pane (the seam the New terminal pick calls)", async () => {
    const far = farPc();
    await open(far);
    await act(async () => void (await registryOf!.spawnPane({ agent_type: 'shell', cwd: 'p-proj', cols: 100, rows: 30 })));
    expect(far.calls).toContainEqual({ cmd: 'spawn_pane', args: { args: { agent_type: 'shell', cwd: 'p-proj', cols: 100, rows: 30 } } });
  });
});
