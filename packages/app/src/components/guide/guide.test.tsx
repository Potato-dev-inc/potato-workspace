// @vitest-environment jsdom
// Project guide: the tab is reachable from the pane (the real PaneView), the consent card starts nothing until the
// person clicks, the pages show with their marks, chips and diagram parts open file tabs, and Stop works.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import { setLanguagePref } from '../../i18n';
import { guidePaletteRows, openGuideTab, isGuidePath } from '../../lib/guide-tabs';
import { resetFileTabs, usePaneFiles } from '../../lib/file-tabs';
import { citationLabel, numberCitations, splitCitations, type GuideApi, type GuideEstimate, type GuideRun, type GuideState, type GuideStructure } from '../../lib/guide';
import { requestPaneAction } from '../../lib/pane-actions';
import { PaneView } from '../cockpit/PaneView';
import { GuideTab } from './GuideTab';
import { GuideSheet } from './GuideSheet';
import { GuideProgress } from './GuideProgress';

const invoke = vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => null);
vi.mock('@tauri-apps/api/core', () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }));
vi.mock('../TerminalViewport', () => ({ TerminalViewport: () => <div data-testid="term" /> }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = NoopResizeObserver;
Element.prototype.scrollIntoView = () => {};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  setLanguagePref('en', false);
  resetFileTabs();
  invoke.mockReset();
  invoke.mockImplementation(async () => null);
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const click = (el: Element | null | undefined) => act(async () => void (el as HTMLElement).click());
const byText = (sel: string, text: string) => [...host.querySelectorAll<HTMLElement>(sel)].find((e) => e.textContent?.includes(text));

const estimate = (over: Partial<GuideEstimate> = {}): GuideEstimate => ({
  token: 'tok-1',
  size: 'normal',
  projectSize: 'medium',
  filesRead: 612,
  filesSkipped: 48,
  skippedByReason: { secret: 3, generated: 40, tooBig: 5 },
  pagesLo: 12,
  pagesHi: 18,
  minutesLo: 6,
  minutesHi: 12,
  chatsLo: 5,
  chatsHi: 12,
  tokensMLo: 0.6,
  tokensMHi: 1.5,
  measured: false,
  tooSmall: false,
  truncated: false,
  ...over,
});

const structure = (over: Partial<GuideStructure> = {}): GuideStructure => ({
  commit: 'a1b2c3d',
  writtenAtMs: Date.now() - 3 * 86_400_000,
  agent: 'claude',
  model: null,
  complete: true,
  pages: [
    { id: 'overview', title: 'Overview', purpose: 'What it is', stale: false, needsReview: false },
    { id: 'sync', title: 'Sync', purpose: 'How sync works', stale: true, needsReview: false },
    { id: 'data', title: 'Data', purpose: 'Storage', stale: false, needsReview: true },
  ],
  diagram: true,
  diagramStale: false,
  ...over,
});

const state = (over: Partial<GuideState> = {}): GuideState => ({ enabled: true, hasGuide: false, structure: null, run: null, last: null, dryRun: true, ...over });

function fakeApi(s: GuideState, over: Partial<GuideApi> = {}) {
  const api: GuideApi = {
    state: vi.fn(async () => s),
    estimate: vi.fn(async (_p: string, size) => estimate({ size: size ?? 'normal' })),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => true),
    readPage: vi.fn(async (_p: string, id: string) => ({
      id,
      title: id,
      markdown: id === 'sync' ? 'Queue lives in [[src/sync/queue.ts:40-88]] and again [[src/sync/queue.ts:40-88]], also [[src/main.ts]].' : `Page ${id}. See [[README.md:1-3]].`,
      stale: id === 'sync',
      changed: id === 'sync' ? ['src/sync/queue.ts'] : [],
      needsReview: id === 'data',
    })),
    readDiagram: vi.fn(async () => ({
      mermaid: 'flowchart LR\n  n0["Overview"]\n  n1["Sync"]\n  n0 --> n1\n',
      boxes: [
        { label: 'Overview', path: 'src/main.ts', page: 'overview' },
        { label: 'Sync page', path: null, page: 'sync' },
      ],
      stale: false,
    })),
    remove: vi.fn(async () => true),
    videoState: vi.fn(async () => ({ enabled: true, running: false, state: null, files: [], canVideo: true })),
    videoStart: vi.fn(async () => undefined),
    videoStop: vi.fn(async () => true),
    videoShow: vi.fn(async () => undefined),
    ...over,
  };
  return api;
}

describe('citations', () => {
  it('turns [[path:40-88]] into chips and keeps everything else as text', () => {
    const parts = splitCitations('See [[src/a.ts:40-88]], [[src/b.ts:7]] and [[src/c.ts]].');
    expect(parts.filter((p) => p.kind === 'cite').map((p) => (p.kind === 'cite' ? [p.path, p.start, p.end] : []))).toEqual([
      ['src/a.ts', 40, 88],
      ['src/b.ts', 7, 7],
      ['src/c.ts', null, null],
    ]);
    expect(citationLabel({ path: 'src/a.ts', start: 40, end: 88 })).toBe('src/a.ts 40-88');
    expect(citationLabel({ path: 'src/b.ts', start: 7, end: 7 })).toBe('src/b.ts 7');
  });

  it('never makes a chip of an absolute path, a drive, ~ or ..; they stay plain text', () => {
    for (const bad of ['/etc/passwd:1', 'C:\\Windows\\win.ini:1', '~/x.ts', '../outside.ts:1', 'a/../../b.ts', '\\\\server\\share\\f.ts']) {
      const parts = splitCitations(`x [[${bad}]] y`);
      expect(parts.every((p) => p.kind === 'text'), bad).toBe(true);
      expect(parts.map((p) => (p.kind === 'text' ? p.text : '')).join('')).toBe(`x [[${bad}]] y`);
    }
  });

  it('handles hostile text: nested brackets, scripts and long input', () => {
    const parts = splitCitations('[[<img src=x onerror=alert(1)>]] [[[[a.ts]]]] ' + '[['.repeat(500));
    expect(parts.some((p) => p.kind === 'cite' && p.path === 'a.ts')).toBe(true);
    expect(numberCitations('one [[a.ts:1-2]] two [[a.ts:1-2]] [[b.ts]]').sources.map((s) => s.n)).toEqual([1, 2]);
    expect(numberCitations('one [[a.ts:1-2]] two [[a.ts:1-2]]').text).toBe('one \u30141\u3015 two \u30141\u3015');
  });
});

describe('the Project guide is wired into the pane', () => {
  function cockpit(): CockpitApi {
    const p = { status: 'idle', info: { id: 'p1', agent_type: 'claude', status: 'idle', pid: 1, created_at: 1, last_output_at: null, cwd: 'C:\\work\\shop', cols: 100, rows: 30 } };
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
      select: vi.fn(),
      notify: vi.fn(),
      answer: vi.fn(),
      closePane: vi.fn(),
    } as unknown as CockpitApi;
  }

  it('the pane action opens the Guide tab, which shows the empty card, and starts nothing', async () => {
    (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'guide_state') return state();
      if (cmd === 'checkpoints_list') return { state: 'ok', message: '', items: [] };
      return null;
    });
    await act(async () => root.render(<PaneView c={cockpit()} paneId="p1" />));
    await flush();
    await act(async () => requestPaneAction('p1', 'guide'));
    await flush();
    await flush();
    expect(host.querySelector('[data-testid="guide-tab"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="guide-empty"]')).not.toBeNull();
    expect(byText('[role="tab"]', 'Project guide')).toBeTruthy();
    expect(invoke.mock.calls.map((c) => c[0])).not.toContain('guide_start');
    expect(invoke.mock.calls.map((c) => c[0])).not.toContain('guide_estimate');
    delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
  });

  it('with the Labs switch off the tab says so and offers nothing', async () => {
    (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
    invoke.mockImplementation(async (cmd: string) => (cmd === 'guide_state' ? state({ enabled: false }) : cmd === 'checkpoints_list' ? { state: 'ok', message: '', items: [] } : null));
    await act(async () => root.render(<PaneView c={cockpit()} paneId="p1" />));
    await act(async () => openGuideTab('p1'));
    await flush();
    await flush();
    expect(host.querySelector('[data-testid="guide-empty"]')).toBeNull();
    expect(host.querySelector('[data-testid="guide-tab"]')!.textContent).toContain('Project guide is off');
    delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
  });

  it('the palette rows exist only while Labs is on', () => {
    expect(guidePaletteRows(false)).toEqual([]);
    expect(guidePaletteRows(true).map((r) => r.title)).toEqual(['Open project guide', 'Make project guide']);
    expect(isGuidePath('guide:')).toBe(true);
    expect(isGuidePath('src/guide:')).toBe(false);
  });
});

describe('the consent card', () => {
  it('shows the estimate, starts nothing on open, and starts with the token only after the click', async () => {
    const api = fakeApi(state());
    await act(async () => root.render(<GuideTab paneId="p1" api={api} project="shop" agentType="claude" agentName="Claude" pollMs={0} />));
    await flush();
    await click(byText('button', 'Make a project guide'));
    await flush();
    const sheet = host.querySelector('[data-testid="guide-sheet"]')!;
    expect(sheet.textContent).toContain('Make a guide for shop?');
    expect(sheet.textContent).toContain('Claude will read this project and write about 12 to 18 pages');
    expect(sheet.textContent).toContain('about 5 to 12 long chats on your plan');
    expect(sheet.textContent).toContain('612 files, skips 48');
    expect(sheet.textContent).toContain('These numbers are first guesses.');
    expect(api.estimate).toHaveBeenCalled();
    expect(api.start).not.toHaveBeenCalled();
    await click(byText('button', 'Make the guide'));
    await flush();
    expect(api.start).toHaveBeenCalledTimes(1);
    expect(api.start).toHaveBeenCalledWith('p1', { token: 'tok-1', mode: 'make', size: 'normal', agent: 'claude' });
  });

  it('Not now starts nothing and goes back to the empty card', async () => {
    const api = fakeApi(state());
    await act(async () => root.render(<GuideTab paneId="p1" api={api} project="shop" agentType="claude" agentName="Claude" pollMs={0} />));
    await flush();
    await click(byText('button', 'Make a project guide'));
    await flush();
    await click(byText('button', 'Not now'));
    expect(api.start).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="guide-empty"]')).not.toBeNull();
  });

  it('offers the dry run only when the PC allows it, and a small project gets a note', async () => {
    const api = fakeApi(state({ dryRun: false }), { estimate: vi.fn(async () => estimate({ tooSmall: true, measured: true })) });
    await act(async () => root.render(<GuideSheet paneId="p1" api={api} project="shop" agentType="claude" agentName="Claude" mode="make" dryRun={false} onStarted={() => undefined} onCancel={() => undefined} />));
    await flush();
    expect(host.textContent).toContain('This project is small');
    expect(host.textContent).not.toContain('first guesses');
    expect(host.textContent).not.toContain('Dry run');
    act(() => root.render(<GuideSheet paneId="p1" api={api} project="shop" agentType="claude" agentName="Claude" mode="refresh" dryRun onStarted={() => undefined} onCancel={() => undefined} />));
    await flush();
    expect(host.textContent).toContain('Dry run');
    expect(host.textContent).toContain('Refresh the guide for shop?');
  });
});

describe('the guide itself', () => {
  async function open(api: GuideApi) {
    await act(async () => {
      root.render(
        <>
          <GuideTab paneId="p1" api={api} project="shop" agentType="claude" agentName="Claude" pollMs={0} />
          <Files />
        </>,
      );
    });
    await flush();
    await flush();
  }
  function Files() {
    const f = usePaneFiles('p1');
    return <output data-testid="files">{f.files.join('|')}</output>;
  }
  const files = () => host.querySelector('[data-testid="files"]')!.textContent;

  it('lists the pages with their marks, says who wrote it, and counts what is out of date', async () => {
    const api = fakeApi(state({ hasGuide: true, structure: structure() }));
    await open(api);
    const list = host.querySelector('.ck-guide-list')!.textContent!;
    expect(list).toContain('Overview');
    expect(list).toContain('Out of date');
    expect(list).toContain('Needs review');
    expect(list).toContain('Diagram');
    expect(host.querySelector('.ck-guide-written')!.textContent).toBe('Written by claude, 3 days ago, at a1b2c3d. Check the linked code.');
    expect(byText('button', 'Refresh (1 out of date)')).toBeTruthy();
    expect(host.querySelector('[data-testid="guide-page"]')!.textContent).toContain('Page overview');
  });

  it('a stale page warns, and a chip for a changed file says so; clicking a chip opens that file', async () => {
    const api = fakeApi(state({ hasGuide: true, structure: structure() }));
    await open(api);
    await click(byText('.ck-guide-item', 'Sync'));
    await flush();
    const page = host.querySelector('[data-testid="guide-page"]')!;
    expect(page.textContent).toContain('Parts of this page may be out of date: src/sync/queue.ts');
    const chips = [...page.querySelectorAll<HTMLElement>('.ck-guide-chip')];
    expect(chips).toHaveLength(2);
    expect(chips[0].getAttribute('aria-label')).toBe('src/sync/queue.ts 40-88 (changed since the guide was written)');
    expect(chips[1].getAttribute('aria-label')).toBe('Open src/main.ts');
    expect(files()).toBe('');
    await click(chips[0]);
    expect(files()).toBe('src/sync/queue.ts');
  });

  it('Refresh opens the card in refresh mode and starts only after the click', async () => {
    const api = fakeApi(state({ hasGuide: true, structure: structure() }));
    await open(api);
    await click(byText('button', 'Refresh (1 out of date)'));
    await flush();
    expect(host.querySelector('[data-testid="guide-sheet"]')!.textContent).toContain('Refresh the guide for shop?');
    expect(api.start).not.toHaveBeenCalled();
    await click(byText('button', 'Refresh the guide'));
    await flush();
    expect(api.start).toHaveBeenCalledWith('p1', { token: 'tok-1', mode: 'refresh', size: 'normal', agent: 'claude' });
  });

  it('the diagram view lists the parts; a part opens its file, or jumps to its page', async () => {
    const api = fakeApi(state({ hasGuide: true, structure: structure() }));
    await open(api);
    await click(byText('.ck-guide-item', 'Diagram'));
    await flush();
    expect(host.querySelector('[data-testid="guide-diagram"]')).not.toBeNull();
    expect(host.querySelector('iframe')).not.toBeNull();
    await click(host.querySelector('[aria-label="Open Overview"]'));
    expect(files()).toBe('src/main.ts');
    await click(host.querySelector('[aria-label="Go to the page: Sync page"]'));
    await flush();
    expect(host.querySelector('[data-testid="guide-page"]')!.textContent).toContain('Queue lives in');
  });

  it('delete asks first and then calls the PC', async () => {
    const api = fakeApi(state({ hasGuide: true, structure: structure() }));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await open(api);
    await click(byText('button', 'More'));
    await click(byText('[role="menuitem"]', 'Delete the guide'));
    expect(api.remove).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    await click(byText('button', 'More'));
    await click(byText('[role="menuitem"]', 'Delete the guide'));
    expect(api.remove).toHaveBeenCalledWith('p1');
    confirm.mockRestore();
  });
});

describe('a run in progress', () => {
  const run = (over: Partial<GuideRun> = {}): GuideRun => ({ kind: 'make', phase: 'pages', pagesTotal: 10, pagesDone: 4, current: ['sync'], calls: 5, tokens: 100, error: null, notes: [], startedMs: 1, finishedMs: null, ...over });

  it('shows plain words, the count and a Stop button that calls the PC', async () => {
    const api = fakeApi(state({ run: run() }));
    await act(async () => root.render(<GuideTab paneId="p1" api={api} pollMs={0} />));
    await flush();
    const card = host.querySelector('[data-testid="guide-progress"]')!;
    expect(card.textContent).toContain('Writing the pages');
    expect(card.textContent).toContain('4 of 10 pages');
    await click(byText('button', 'Stop'));
    expect(api.stop).toHaveBeenCalledWith('p1');
  });

  it('a finished run has no Stop button', async () => {
    const api = fakeApi(state());
    await act(async () => root.render(<GuideProgress paneId="p1" api={api} run={run({ phase: 'stopped' })} />));
    expect(byText('button', 'Stop')).toBeUndefined();
    expect(host.textContent).toContain('Stopped. The finished pages are kept.');
  });

  it('polls while a run goes', async () => {
    vi.useFakeTimers();
    const api = fakeApi(state({ run: run() }));
    await act(async () => root.render(<GuideTab paneId="p1" api={api} pollMs={1500} />));
    const before = (api.state as ReturnType<typeof vi.fn>).mock.calls.length;
    await act(async () => void (await vi.advanceTimersByTimeAsync(3100)));
    expect((api.state as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(before + 2);
  });
});
