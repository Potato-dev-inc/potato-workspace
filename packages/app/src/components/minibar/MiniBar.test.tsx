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
  kill: vi.fn(async (_id: string) => {}),
  fit: vi.fn(async (_w: number) => {}),
}));

vi.mock('../../lib/tauri', () => ({
  tauri: {
    listPanes: async () => api.panes,
    onPanesChanged: () => Promise.resolve(() => {}),
    onPtyStatus: () => Promise.resolve(() => {}),
    killPane: (id: string) => api.kill(id),
  },
}));
vi.mock('../../lib/cockpit-api', () => ({
  cockpitApi: {
    miniBarToastLeft: async () => api.toastLeft,
    miniBarFocusPane: (id: string) => api.focus(id),
    miniBarFit: (w: number) => api.fit(w),
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
  api.kill.mockReset();
  api.kill.mockResolvedValue(undefined);
  api.fit.mockClear();
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

describe('MiniBar with many agents', () => {
  const many = () => Array.from({ length: 12 }, (_, i) => pane(`p${i}`, 'claude', `/x/proj${i}`));
  const strip = () => host.querySelector('.mb-chips') as HTMLElement;
  const sizes = (el: HTMLElement, scrollWidth: number, clientWidth: number) => {
    Object.defineProperty(el, 'scrollWidth', { value: scrollWidth, configurable: true });
    Object.defineProperty(el, 'clientWidth', { value: clientWidth, configurable: true });
  };
  const wheel = (el: HTMLElement, deltaY: number) =>
    act(() => {
      el.dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true }));
    });

  it('the mouse wheel scrolls the chip strip sideways', async () => {
    api.panes = many();
    act(() => root.render(createElement(MiniBarApp)));
    await flush();
    const el = strip();
    sizes(el, 2000, 400);
    el.scrollLeft = 0;
    wheel(el, 120);
    expect(el.scrollLeft).toBe(120);
    wheel(el, -50);
    expect(el.scrollLeft).toBe(70);
  });

  it('shows an edge fade on the sides that hide chips', async () => {
    api.panes = many();
    act(() => root.render(createElement(MiniBarApp)));
    await flush();
    const el = strip();
    sizes(el, 2000, 400);
    wheel(el, 100);
    const wrap = host.querySelector('.mb-chips-wrap')!;
    expect(wrap.classList.contains('mb-fade-start')).toBe(true);
    expect(wrap.classList.contains('mb-fade-end')).toBe(true);
  });

  it('keeps + New and Back to Orchestration outside the scrolling strip', async () => {
    api.panes = many();
    act(() => root.render(createElement(MiniBarApp)));
    await flush();
    expect(strip().contains(button('+ New')!)).toBe(false);
    expect(strip().contains(button('Back to Orchestration')!)).toBe(false);
  });

  it('asks the window for the width the chips need', async () => {
    api.panes = many();
    const proto = HTMLElement.prototype;
    Object.defineProperty(proto, 'scrollWidth', { configurable: true, get: () => 1500 });
    try {
      act(() => root.render(createElement(MiniBarApp)));
      await flush();
      expect(api.fit).toHaveBeenCalled();
      expect(api.fit.mock.calls.at(-1)![0]).toBeGreaterThan(0);
    } finally {
      delete (proto as unknown as Record<string, unknown>).scrollWidth;
    }
  });

  it('the x closes that agent through the pane close command, does not focus, and the list updates', async () => {
    api.panes = [pane('a1', 'claude', '/p/one'), pane('b2', 'codex', '/p/two')];
    api.kill.mockImplementation(async (id: string) => {
      api.panes = api.panes.filter((p) => p.id !== id);
    });
    act(() => root.render(createElement(MiniBarApp)));
    await flush();
    const x = host.querySelector('button[aria-label="Close Codex two"]') as HTMLButtonElement;
    expect(x).toBeTruthy();
    expect(x.tabIndex).toBeGreaterThanOrEqual(0);
    act(() => x.click());
    await flush();
    expect(api.kill).toHaveBeenCalledWith('b2');
    expect(api.focus).not.toHaveBeenCalled();
    expect([...host.querySelectorAll('.mb-chip')].map((c) => c.textContent)).toEqual(['Claudeone']);
  });

  it('Delete on a focused chip closes it', async () => {
    api.panes = [pane('a1', 'claude', '/p/one')];
    act(() => root.render(createElement(MiniBarApp)));
    await flush();
    const chip = host.querySelector('.mb-chip') as HTMLElement;
    act(() => {
      chip.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
    });
    await flush();
    expect(api.kill).toHaveBeenCalledWith('a1');
    expect(api.focus).not.toHaveBeenCalled();
  });
});
