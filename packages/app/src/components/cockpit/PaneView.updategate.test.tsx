// @vitest-environment jsdom
// A terminal agent's update gate, as the backend sends it for a menu it read by its shape: the card says what the
// agent asks, keeps the agent's own words on the buttons, shows what "Update now" runs, and stays on both tabs.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { ChatItem } from '../../lib/sessionChat';
import { PaneView } from './PaneView';

const invoke = vi.fn(async (_cmd: string, _args?: unknown) => null as unknown);
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => (invoke as (...x: unknown[]) => unknown)(...(a as [string])) }));
vi.mock('../TerminalViewport', () => ({ TerminalViewport: () => <div data-testid="term" /> }));
vi.mock('../../lib/sessionChat', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/sessionChat')>()),
  openSessionChat: vi.fn(async () => ({ available: true, reason: null, items: SAMPLE })),
  closeSessionChat: vi.fn(async () => undefined),
  onSessionChatItems: vi.fn(async () => () => undefined),
  onSessionChatStatus: vi.fn(async () => () => undefined),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = NoopResizeObserver;
Element.prototype.scrollIntoView = () => {};

const SAMPLE: ChatItem[] = [{ kind: 'user', id: '10:0', at: null, text: 'List the files' }];

const COMMAND = "powershell -ExecutionPolicy Bypass -c 'irm https://example.com/install.ps1 | iex'";
// Same shape as the Rust card (`pane_prompt` / `pty://prompt`): the labels are the screen's own words.
const UPDATE_GATE = {
  promptId: 'prompt-update',
  kind: 'unknown_question',
  text: ['Update available', 'Update now', 'Skip', 'Skip until next version'].join('\n'),
  summary: 'Update available (recognised by shape, not by profile: a numbered menu)',
  choices: [
    { id: 'option_1', label: `Update now (runs \`${COMMAND}\`)`, broad: false },
    { id: 'option_2', label: 'Skip', broad: false },
    { id: 'option_3', label: 'Skip until next version', broad: false },
  ],
  risk: { level: 'high', headline: 'Download and run code from the internet', reasons: ['Update available · 0.166.0 → 0.167.0', 'It downloads a script and runs it at once.'] },
};

function cockpit(prompt: unknown, answer = vi.fn()): CockpitApi {
  const info = { id: 'p1', agent_type: 'zeta', status: 'waiting_input', pid: 4120, created_at: 1, last_output_at: null, cwd: 'C:\work\shop', cols: 158, rows: 56 };
  const p = { status: 'waiting_input', info };
  return {
    registry: { paneList: [p], panes: new Map([['p1', p]]), initialReady: true },
    names: new Map([['p1', 'Agent']]),
    activities: {},
    previews: {},
    asked: { questions: [] },
    prompts: { p1: prompt },
    statusSince: new Map(),
    now: 12_000,
    selectedId: 'p1',
    mode: 'orchestration',
    select: vi.fn(),
    notify: vi.fn(),
    answer,
    closePane: vi.fn(),
  } as unknown as CockpitApi;
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'checkpoints_list') return { state: 'ok', message: '', items: [] };
    return null;
  });
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

const flush = () =>
  act(async () => {
    await new Promise((r) => setImmediate(r));
  });
const tab = (name: string) => [...host.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent === name)!;
const card = () => host.querySelector('.ck-pane-body .ib-approval');
const buttons = () => Array.from(card()!.querySelectorAll<HTMLElement>('[data-choice]')).map((b) => b.textContent);

describe('the update gate card', () => {
  it('says what the agent asks, keeps the agent words, names the command, and has no "Allow once"', async () => {
    const c = cockpit(UPDATE_GATE);
    await act(async () => root.render(<PaneView c={c} paneId="p1" />));
    await flush();
    const text = card()!.textContent ?? '';
    expect(text).toContain('Update available');
    expect(text).toContain('0.166.0');
    expect(text).toContain('Runs:');
    expect(text).toContain('install.ps1');
    expect(buttons()).toEqual(['Update now', 'Skip', 'Skip until next version']);
    expect(text).not.toContain('Allow once');
    expect(text).not.toContain('cannot summarise');
  });

  it('answers with the option the button names, not another', async () => {
    const answer = vi.fn();
    await act(async () => root.render(<PaneView c={cockpit(UPDATE_GATE, answer)} paneId="p1" />));
    await flush();
    const click = async (label: string) => act(async () => Array.from(card()!.querySelectorAll<HTMLElement>('[data-choice]')).find((b) => b.textContent === label)!.click());
    await click('Update now');
    await click('Skip until next version');
    await click('Skip');
    expect(answer.mock.calls.map((a) => a[2])).toEqual(['option_1', 'option_3', 'option_2']);
  });

  it('stays on screen when the person switches between Chat and Terminal and back', async () => {
    const c = cockpit(UPDATE_GATE);
    await act(async () => root.render(<PaneView c={c} paneId="p1" />));
    await flush();
    for (const name of ['Chat', 'Terminal', 'Chat', 'Terminal']) {
      await act(async () => tab(name).click());
      await flush();
      expect(card(), `card on ${name}`).not.toBeNull();
      expect(buttons()).toEqual(['Update now', 'Skip', 'Skip until next version']);
    }
  });
});
