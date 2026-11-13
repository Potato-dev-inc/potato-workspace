// @vitest-environment jsdom
// The Hand off button with the real starter (useHandoff) and the real PaneView, for each "Hand off does" choice: Quick
// handoff saves HANDOFF.md and opens nothing; Handoff to new agent (the default) uses a temporary file, then "Ready".
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import { useHandoff } from '../../hooks/useHandoff';
import { fileWritePrompt, quickStartPrompt, quickWritePrompt, type HandoffDeps } from '../../lib/handoff';
import { PaneView } from './PaneView';

const invoke = vi.fn(async (cmd: string) => (cmd === 'checkpoints_list' ? { state: 'ok', message: '', items: [] } : null) as unknown);
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => (invoke as (...x: unknown[]) => unknown)(...(a as [string])) }));
vi.mock('../TerminalViewport', () => ({ TerminalViewport: () => <div data-testid="term" /> }));
const settings = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('../../lib/settings', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/settings')>();
  return { ...real, loadSettings: vi.fn(async () => ({ ...settings.value })) };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = NoopResizeObserver;
Element.prototype.scrollIntoView = () => {};

const PATH = 'C:/work/shop/.potato/handoffs/handoff-20261111-0930.md';

function cockpit(): CockpitApi {
  const p = { status: 'idle', info: { id: 'p1', agent_type: 'claude', status: 'idle', pid: 1, created_at: 1, last_output_at: null, cwd: 'C:/work/shop', cols: 80, rows: 24 } };
  return {
    registry: { paneList: [p], panes: new Map([['p1', p]]), initialReady: true },
    names: new Map([['p1', 'Claude']]),
    activities: {},
    previews: {},
    asked: { questions: [] },
    prompts: {},
    statusSince: new Map(),
    now: 12_000,
    selectedId: 'p1',
    mode: 'orchestration',
    launchEntries: [{ type: 'claude', label: 'Claude' }],
    select: vi.fn(),
    notify: vi.fn(),
  } as unknown as CockpitApi;
}

/** Fake calls: an agent shows as running for two polls after it gets a message. */
function fakes() {
  const busy: Record<string, number> = { p1: 0, n1: 0 };
  const sent: Array<[string, string]> = [];
  let clock = 0;
  const deps: HandoffDeps = {
    pane: vi.fn((id: string) => ({ id, agentType: 'claude', cwd: 'C:/work/shop', lane: undefined, status: (busy[id] ?? 0) > 0 ? 'running' : 'idle' })),
    chatState: vi.fn(async () => null),
    send: vi.fn(async (id: string, text: string) => {
      sent.push([id, text]);
      busy[id] = 2;
    }),
    stat: vi.fn(async (_id: string, stamp?: string) => (stamp ? { exists: sent.length > 0, modifiedMs: 5, bytes: 50 } : { exists: sent.length > 0, modifiedMs: sent.length, bytes: 50 })),
    startTerminal: vi.fn(async () => 'n1'),
    startChat: vi.fn(async () => 'n1'),
    startTerminalChat: vi.fn(async () => 'n1'),
    setConfig: vi.fn(async () => undefined),
    select: vi.fn(),
    titleOf: vi.fn(() => 'Claude two'),
    sleep: vi.fn(async (ms: number) => {
      clock += ms;
      for (const id of Object.keys(busy)) if (busy[id] > 0) busy[id] -= 1;
    }),
    now: () => clock,
    quick: {
      stamp: vi.fn(() => '20261111-0930'),
      prepare: vi.fn(async (_id: string, stamp: string) => ({ stamp, path: PATH })),
      appendNotes: vi.fn(async () => undefined),
      archive: vi.fn(async () => 'D:/data/handoffs/shop/handoff.md'),
      account: vi.fn(async () => 'acct-2'),
    },
  };
  return { deps, sent };
}

function Harness({ deps }: { deps: HandoffDeps }) {
  const c = cockpit();
  const handoff = useHandoff(c, deps);
  return <PaneView c={c} paneId="p1" handoff={handoff} />;
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
  invoke.mockImplementation(async (cmd: string) => (cmd === 'checkpoints_list' ? { state: 'ok', message: '', items: [] } : null));
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
});

const flush = () => act(async () => { await new Promise((r) => setImmediate(r)); });
const btn = () => host.querySelector<HTMLButtonElement>('[data-testid="pane-handoff"]');
async function press(deps: HandoffDeps) {
  await act(async () => root.render(<Harness deps={deps} />));
  await flush();
  act(() => btn()!.click());
  for (let i = 0; i < 12; i++) await flush();
}

// These tests are about the pane, not the side panel: a window under 960 px (240 sidebar + 240 panel + 480 chat) has none.
Object.defineProperty(window, 'innerWidth', { value: 900, configurable: true });

describe('pane header: Hand off follows the "Hand off does" setting', () => {
  it('Handoff to new agent: label, temporary file, fixed notes, the same agent with its sign-in, Ready, file moved', async () => {
    settings.value = { handoff_mode: 'new_agent', handoff_fixed_notes: 'Reply short.' };
    const { deps, sent } = fakes();
    await press(deps);
    expect(btn()!.textContent).toBe('Hand off');
    expect(sent[0]).toEqual(['p1', quickWritePrompt(PATH)]);
    expect(sent[0][1]).toContain('.potato/handoffs/handoff-');
    expect(deps.quick.appendNotes).toHaveBeenCalledWith('p1', '20261111-0930', 'Reply short.');
    expect(deps.startTerminal).toHaveBeenCalledWith('claude', 'C:/work/shop', 'acct-2');
    expect(sent[1]).toEqual(['n1', quickStartPrompt(PATH)]);
    expect(deps.quick.archive).toHaveBeenCalledWith('p1', '20261111-0930');
  });

  it('Quick handoff: label, HANDOFF.md with both parts, fixed notes added to it, and no new agent', async () => {
    settings.value = { handoff_mode: 'file', handoff_fixed_notes: 'Reply short.' };
    const { deps, sent } = fakes();
    await press(deps);
    expect(btn()!.textContent).toBe('Quick handoff');
    expect(sent).toEqual([['p1', fileWritePrompt()]]);
    expect(sent[0][1]).toContain('## Part 2: How this person works');
    expect(deps.quick.appendNotes).toHaveBeenCalledWith('p1', undefined, 'Reply short.');
    expect(deps.startTerminal).not.toHaveBeenCalled();
    expect(deps.quick.prepare).not.toHaveBeenCalled();
    expect(deps.quick.archive).not.toHaveBeenCalled();
  });

  it('no saved choice (an older settings file): Handoff to new agent', async () => {
    settings.value = {};
    const { deps, sent } = fakes();
    await press(deps);
    expect(btn()!.textContent).toBe('Hand off');
    expect(sent[0]).toEqual(['p1', quickWritePrompt(PATH)]);
    expect(deps.quick.appendNotes).not.toHaveBeenCalled();
  });
});
