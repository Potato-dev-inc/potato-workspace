// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MiniBar, projectName } from './MiniBar';
import MiniBarApp from './MiniBarApp';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  panes: [] as Array<Record<string, unknown>>,
  toastLeft: 0,
  setUiMode: vi.fn(async (_mode: string) => {}),
  focus: vi.fn(async (_id: string) => {}),
}));

vi.mock('../../lib/tauri', () => ({
  tauri: {
    listPanes: async () => api.panes,
    onPanesChanged: () => Promise.resolve(() => {}),
    onPtyStatus: () => Promise.resolve(() => {}),
  },
}));
vi.mock('../../lib/cockpit-api', () => ({
  cockpitApi: {
    miniBarToastLeft: async () => api.toastLeft,
    miniBarFocusPane: (id: string) => api.focus(id),
    onMiniBarShown: () => Promise.resolve(() => {}),
    setUiMode: (m: string) => api.setUiMode(m),
  },
}));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  api.panes = [];
  api.toastLeft = 0;
  api.setUiMode.mockClear();
  api.focus.mockClear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});
const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
const flush = () => act(async () => void (await vi.advanceTimersByTimeAsync(0)));
const pane = (id: string, agent: string, cwd: string, status = 'idle') => ({ id, agent_type: agent, cwd, status });

describe('MiniBar', () => {
  it('names a project by its last folder, either slash style', () => {
    expect(projectName('C:\\work\\my-app')).toBe('my-app');
    expect(projectName('/home/me/app/')).toBe('app');
  });

  it('with no agents says so and offers to start one', () => {
    act(() => root.render(createElement(MiniBar, { panes: [], toast: false, onFocusPane: () => {}, onNew: () => {}, onBack: () => {}, onUndo: () => {} })));
    expect(host.textContent).toContain('No agents yet');
    expect(button('Start one')).toBeTruthy();
    expect(button('Back to Orchestration')).toBeTruthy();
  });
});

describe('MiniBarApp (the real window content)', () => {
  it('shows a chip per live agent (agent + project); a click focuses that pane; companions are left out', async () => {
    api.panes = [pane('a1', 'claude', 'C:\\work\\shop', 'running'), pane('b2', 'codex', '/x/api'), pane('companion-mochi', 'claude', '/x')];
    act(() => root.render(createElement(MiniBarApp)));
    await flush();
    const chips = [...host.querySelectorAll('.mb-chip')];
    expect(chips.map((c) => c.textContent)).toEqual(['Claudeshop', 'Codexapi']);
    expect(host.querySelector('.mb-dot--running')).toBeTruthy();
    act(() => (chips[1] as HTMLElement).click());
    expect(api.focus).toHaveBeenCalledWith('b2');
  });

  it('a chat session (ACP) is a normal chip: it focuses its pane window and never mentions a missing terminal', async () => {
    api.panes = [{ ...pane('c1', 'codex', '/x/api', 'running'), lane: 'acp' }];
    act(() => root.render(createElement(MiniBarApp)));
    await flush();
    const chip = host.querySelector('.mb-chip') as HTMLElement;
    expect(chip.textContent).toBe('Codexapi');
    expect(chip.title).toContain('Chat');
    expect(host.textContent).not.toMatch(/no terminal|not available/i);
    act(() => chip.click());
    expect(api.focus).toHaveBeenCalledWith('c1');
  });

  it('zero panes: "No agents yet" and Start one goes back to Orchestration', async () => {
    act(() => root.render(createElement(MiniBarApp)));
    await flush();
    expect(host.textContent).toContain('No agents yet');
    act(() => button('Start one')!.click());
    expect(api.setUiMode).toHaveBeenCalledWith('orchestration');
  });

  it('the Undo toast shows after a switch, Undo restores Orchestration, and it goes away after its time', async () => {
    api.panes = [pane('a1', 'claude', '/p')];
    api.toastLeft = 8000;
    act(() => root.render(createElement(MiniBarApp)));
    await flush();
    expect(host.textContent).toContain('Each agent now has its own window.');
    act(() => button('Undo')!.click());
    expect(api.setUiMode).toHaveBeenCalledWith('orchestration');
    await act(async () => void (await vi.advanceTimersByTimeAsync(8001)));
    expect(host.textContent).not.toContain('Undo');
    expect(host.querySelector('.mb-chip')).toBeTruthy();
  });

  it('Back to Orchestration switches the mode', async () => {
    api.panes = [pane('a1', 'claude', '/p')];
    act(() => root.render(createElement(MiniBarApp)));
    await flush();
    act(() => button('Back to Orchestration')!.click());
    expect(api.setUiMode).toHaveBeenCalledWith('orchestration');
  });
});
