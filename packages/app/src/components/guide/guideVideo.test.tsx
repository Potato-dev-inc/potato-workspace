// @vitest-environment jsdom
// Video tour: the button is on the real Guide tab (and in the real pane), the card starts nothing until the click,
// progress and Stop work, the result tells the truth (video or only the slideshow), and the words exist in both languages.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import { setLanguagePref } from '../../i18n';
import { resetFileTabs } from '../../lib/file-tabs';
import type { GuideApi, GuideState, GuideStructure, GuideVideoRun, GuideVideoState } from '../../lib/guide';
import { requestPaneAction } from '../../lib/pane-actions';
import { PaneView } from '../cockpit/PaneView';
import { GuideTab } from './GuideTab';

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
});

const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const click = (el: Element | null | undefined) => act(async () => void (el as HTMLElement).click());
const byText = (sel: string, text: string) => [...host.querySelectorAll<HTMLElement>(sel)].find((e) => e.textContent?.includes(text));

const structure: GuideStructure = {
  commit: 'a1b2c3d',
  writtenAtMs: Date.now() - 86_400_000,
  agent: 'claude',
  model: null,
  complete: true,
  pages: [{ id: 'overview', title: 'Overview', purpose: 'What it is', stale: false, needsReview: false }],
  diagram: true,
  diagramStale: false,
};
const guideState = (over: Partial<GuideState> = {}): GuideState => ({ enabled: true, hasGuide: true, structure, run: null, last: null, dryRun: false, ...over });
const run = (over: Partial<GuideVideoRun> = {}): GuideVideoRun => ({
  phase: 'frames',
  framesDone: 120,
  framesTotal: 240,
  beats: 22,
  seconds: 88.4,
  error: null,
  outcome: null,
  files: [],
  notes: [],
  startedMs: 1,
  finishedMs: null,
  ...over,
});
const vstate = (over: Partial<GuideVideoState> = {}): GuideVideoState => ({ enabled: true, running: false, state: null, files: [], canVideo: true, ...over });

function fakeApi(over: Partial<GuideApi> = {}, s: GuideState = guideState()): GuideApi {
  return {
    state: vi.fn(async () => s),
    estimate: vi.fn(),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => true),
    readPage: vi.fn(async (_p: string, id: string) => ({ id, title: id, markdown: 'Page. See [[README.md:1-3]].', stale: false, changed: [], needsReview: false })),
    readDiagram: vi.fn(),
    remove: vi.fn(async () => true),
    videoState: vi.fn(async () => vstate()),
    videoStart: vi.fn(async () => undefined),
    videoStop: vi.fn(async () => true),
    videoShow: vi.fn(async () => undefined),
    ...over,
  } as GuideApi;
}

async function openTab(api: GuideApi, pollMs = 0) {
  await act(async () => root.render(<GuideTab paneId="p1" api={api} project="shop" agentType="claude" agentName="Claude" pollMs={pollMs} />));
  await flush();
}

describe('the video tour button', () => {
  it('sits on the Guide tab, opens a card, and starts nothing until "Make the tour"', async () => {
    const api = fakeApi();
    await openTab(api);
    await click(host.querySelector('[data-testid="guide-video-button"]'));
    await flush();
    const card = host.querySelector('[data-testid="guide-video"]')!;
    expect(card.textContent).toContain('Make a video tour of shop?');
    expect(card.textContent).toContain('none. No agent is used.');
    expect(card.textContent).toContain('No voice, nothing is uploaded.');
    expect(api.videoStart).not.toHaveBeenCalled();
    await click(byText('button', 'Make the tour'));
    await flush();
    expect(api.videoStart).toHaveBeenCalledTimes(1);
    expect(api.videoStart).toHaveBeenCalledWith('p1', { vertical: false, language: 'en' });
  });

  it('Not now closes the card and goes back to the pages', async () => {
    const api = fakeApi();
    await openTab(api);
    await click(host.querySelector('[data-testid="guide-video-button"]'));
    await flush();
    await click(byText('button', 'Not now'));
    expect(api.videoStart).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="guide-video"]')).toBeNull();
    expect(host.querySelector('[data-testid="guide-video-button"]')).not.toBeNull();
  });

  it('the tall video is a checkbox that is sent with the start', async () => {
    const api = fakeApi();
    await openTab(api);
    await click(host.querySelector('[data-testid="guide-video-button"]'));
    await flush();
    await click(host.querySelector('input[type="checkbox"]'));
    await click(byText('button', 'Make the tour'));
    await flush();
    expect(api.videoStart).toHaveBeenCalledWith('p1', { vertical: true, language: 'en' });
  });

  it('says plainly when this PC can only make the slideshow, and the tall option is off', async () => {
    const api = fakeApi({ videoState: vi.fn(async () => vstate({ canVideo: false })) });
    await openTab(api);
    await click(host.querySelector('[data-testid="guide-video-button"]'));
    await flush();
    expect(host.querySelector('[data-testid="guide-video-notools"]')!.textContent).toContain('captioned slideshow');
    expect((host.querySelector('input[type="checkbox"]') as HTMLInputElement).disabled).toBe(true);
  });

  it('a start that the PC refuses shows the sentence and stays on the card', async () => {
    const api = fakeApi({ videoStart: vi.fn(async () => Promise.reject(new Error('VIDEO_BUSY: A video tour is already being made in this project.'))) });
    await openTab(api);
    await click(host.querySelector('[data-testid="guide-video-button"]'));
    await flush();
    await click(byText('button', 'Make the tour'));
    await flush();
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('already being made');
    expect(host.querySelector('[data-testid="guide-video"]')).not.toBeNull();
  });

  it('is not there with Labs off or without a guide', async () => {
    await openTab(fakeApi({}, guideState({ enabled: false, hasGuide: false, structure: null })));
    expect(host.querySelector('[data-testid="guide-video-button"]')).toBeNull();
    await openTab(fakeApi({}, guideState({ hasGuide: false, structure: null })));
    expect(host.querySelector('[data-testid="guide-video-button"]')).toBeNull();
  });
});

describe('progress and the result', () => {
  it('shows the frame count and a bar, and Stop calls the PC', async () => {
    const api = fakeApi({ videoState: vi.fn(async () => vstate({ running: true, state: run() })) });
    await openTab(api);
    await click(host.querySelector('[data-testid="guide-video-button"]'));
    await flush();
    const bar = host.querySelector('[role="progressbar"]')!;
    expect(bar.getAttribute('aria-valuenow')).toBe('50');
    expect(host.textContent).toContain('120 of 240 frames');
    expect(host.textContent).toContain('Drawing the video...');
    await click(byText('button', 'Stop'));
    expect(api.videoStop).toHaveBeenCalledWith('p1');
  });

  it('polls while a tour is being made', async () => {
    const api = fakeApi({ videoState: vi.fn(async () => vstate({ running: true, state: run({ phase: 'plan', framesTotal: 0 }) })) });
    await openTab(api, 15);
    await click(host.querySelector('[data-testid="guide-video-button"]'));
    await act(async () => void (await new Promise((r) => setTimeout(r, 120))));
    expect((api.videoState as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(host.textContent).toContain('Planning the tour...');
  });

  it('a finished video shows its files and the summary; Show in folder calls the PC', async () => {
    const files = ['.potato/guide/video/tour.mp4', '.potato/guide/video/tour-vertical.mp4', '.potato/guide/video/tour.html'];
    const api = fakeApi({ videoState: vi.fn(async () => vstate({ files, state: run({ phase: 'done', outcome: 'video', files, finishedMs: 9 }) })) });
    await openTab(api);
    await click(host.querySelector('[data-testid="guide-video-button"]'));
    await flush();
    const card = host.querySelector('[data-testid="guide-video"]')!;
    expect(card.textContent).toContain('Your video tour is ready.');
    expect(card.textContent).toContain('22 beats, about 88 seconds.');
    expect(card.textContent).toContain('Video (wide)');
    expect(card.textContent).toContain('Video (tall, for phones)');
    await click(byText('button', 'Show in folder'));
    expect(api.videoShow).toHaveBeenCalledWith('p1');
  });

  it('when only the slideshow could be made it says so, with the reason, and "Make it again" returns to the question', async () => {
    const files = ['.potato/guide/video/tour.html'];
    const note = 'No video was made because this PC has no ffmpeg. A captioned slideshow is ready instead.';
    const api = fakeApi({ videoState: vi.fn(async () => vstate({ canVideo: false, files, state: run({ phase: 'done', outcome: 'slideshow', files, notes: [note] }) })) });
    await openTab(api);
    await click(host.querySelector('[data-testid="guide-video-button"]'));
    await flush();
    const card = host.querySelector('[data-testid="guide-video"]')!;
    expect(card.textContent).toContain('Your slideshow is ready.');
    expect(card.textContent).toContain(note);
    expect(card.textContent).not.toContain('Video (wide)');
    await click(byText('button', 'Make it again'));
    expect(host.querySelector('[data-testid="guide-video"]')!.textContent).toContain('Make a video tour of shop?');
  });

  it('a failed tour says so', async () => {
    const api = fakeApi({ videoState: vi.fn(async () => vstate({ state: run({ phase: 'failed', error: 'VIDEO_SPAWN: Could not start Node.' }) })) });
    await openTab(api);
    await click(host.querySelector('[data-testid="guide-video-button"]'));
    await flush();
    expect(host.textContent).toContain('The tour could not be made.');
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('Could not start Node');
  });
});

describe('in the real pane and in Traditional Chinese', () => {
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

  it('the pane opens the Guide tab; the video button starts the tour through the PC command with the app language', async () => {
    (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
    setLanguagePref('zh-TW', false);
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'guide_state') return guideState();
      if (cmd === 'guide_video_state') return vstate();
      if (cmd === 'checkpoints_list') return { state: 'ok', message: '', items: [] };
      return null;
    });
    await act(async () => root.render(<PaneView c={cockpit()} paneId="p1" />));
    await flush();
    await act(async () => requestPaneAction('p1', 'guide'));
    await flush();
    await flush();
    const button = host.querySelector('[data-testid="guide-video-button"]')!;
    expect(button.textContent).toBe('製作影片導覽');
    await click(button);
    await flush();
    expect(host.querySelector('[data-testid="guide-video"]')!.textContent).toContain('要製作');
    expect(invoke.mock.calls.map((c) => c[0])).not.toContain('guide_video_start');
    await click(byText('button', '開始製作'));
    await flush();
    expect(invoke).toHaveBeenCalledWith('guide_video_start', { paneId: 'p1', vertical: false, language: 'zh-TW' });
    delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
  });
});
