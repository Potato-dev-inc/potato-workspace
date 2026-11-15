// @vitest-environment jsdom
// "Check it in the browser" (R4-11), through the real pane screen: the Check it chip next to Preview (only with the
// Labs switch on), the card it leaves in the Chat tab (pass, fail with a picture, sign-in, error) and "Ask the agent
// to fix it", which writes to the pane's own message box.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { PreviewMap } from '../../lib/pane-preview';
import type { CheckReport } from '../../lib/browser-check';
import { PaneView } from './PaneView';

let labsOn = true;
let openFails = false;
let answer: () => Promise<CheckReport> = async () => PASS;
const invoke = vi.fn(async (cmd: string) => {
  if (cmd === 'checkpoints_list') return { state: 'ok', message: '', items: [] };
  if (cmd === 'browser_check_enabled') return labsOn;
  if (cmd === 'browser_check_it') return answer();
  if (cmd === 'browser_open_window') {
    if (openFails) throw 'That is not a web address.';
    return null;
  }
  if (cmd === 'pane_message_send') return { id: 'm1', text: '', createdAt: 1, state: 'queued', waitingFor: null, error: null };
  return null;
});
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => (invoke as (...x: unknown[]) => unknown)(...(a as [string])) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock('../TerminalViewport', () => ({ TerminalViewport: () => <div data-testid="term" /> }));
vi.mock('../../lib/sessionChat', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/sessionChat')>()),
  openSessionChat: vi.fn(async () => ({ available: true, reason: null, items: [] })),
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

const PREVIEWS: PreviewMap = { p1: [{ url: 'http://localhost:5173/', port: 5173 }] };
const PASS: CheckReport = { verdict: 'pass', pass: true, url: 'http://localhost:5173/', title: 'Shop', loaded: true, problem_count: 0, problems: [], screenshot: 'data:image/jpeg;base64,QUJD' };
const FAIL: CheckReport = {
  ...PASS,
  verdict: 'fail',
  pass: false,
  problem_count: 7,
  problems: ['error: Cannot read properties of undefined', 'request: GET /api/items failed (net::ERR_CONNECTION_REFUSED)', 'error: c', 'error: d', 'error: e'],
};

function cockpit(previews: PreviewMap): CockpitApi {
  const list = [1, 2].map((n) => ({
    status: 'idle',
    info: { id: `p${n}`, agent_type: 'a', status: 'idle', pid: n, created_at: 1, last_output_at: null, cwd: 'C:\\work\\shop', cols: 158, rows: 56 },
  }));
  return {
    registry: { paneList: list, panes: new Map(list.map((p) => [p.info.id, p])), initialReady: true },
    names: new Map([
      ['p1', 'Agent'],
      ['p2', 'Other'],
    ]),
    activities: {},
    previews,
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

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
  invoke.mockClear();
  labsOn = true;
  openFails = false;
  answer = async () => PASS;
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
const chip = () => host.querySelector<HTMLButtonElement>('[data-testid="pane-check-it"]');
const card = () => host.querySelector<HTMLElement>('[data-testid="check-card"]');
const verdict = () => host.querySelector('[data-testid="check-verdict"]')?.textContent;
const openChat = () => act(() => [...host.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent === 'Chat')!.click());
const calls = (cmd: string) => (invoke.mock.calls as unknown[][]).filter((c) => c[0] === cmd);

async function runCheck(c: CockpitApi) {
  act(() => root.render(<PaneView c={c} paneId="p1" />));
  await flush();
  act(() => chip()!.click());
  await flush();
  openChat();
  await flush();
}

describe('Check it chip', () => {
  it('shows next to Preview when the Labs switch is on and the pane has a page', async () => {
    act(() => root.render(<PaneView c={cockpit(PREVIEWS)} paneId="p1" />));
    await flush();
    expect(chip()?.textContent).toBe('Check it');
    expect(host.querySelector('.ck-preview-chip')).not.toBeNull();
  });

  it('is not there with the Labs switch off, or with no page to check', async () => {
    labsOn = false;
    act(() => root.render(<PaneView c={cockpit(PREVIEWS)} paneId="p1" />));
    await flush();
    expect(chip()).toBeNull();
    labsOn = true;
    act(() => root.render(<PaneView c={cockpit({})} paneId="p1" />));
    await flush();
    expect(chip()).toBeNull();
    expect(calls('browser_check_enabled')).toHaveLength(1);
  });
});

describe('the card in the Chat tab', () => {
  it('says pass and shows the picture the agent browser took', async () => {
    await runCheck(cockpit(PREVIEWS));
    expect(calls('browser_check_it')[0]).toEqual(['browser_check_it', { paneId: 'p1', url: 'http://localhost:5173/' }]);
    expect(verdict()).toBe('Looks good');
    expect(card()!.querySelector('img')!.getAttribute('src')).toBe('data:image/jpeg;base64,QUJD');
    expect(card()!.textContent).toContain('no errors');
    expect(host.querySelector('.ck-check-foot')).toBeNull();
  });

  it('says fail, lists the problems (five, then how many more) and keeps page words as plain text', async () => {
    answer = async () => ({ ...FAIL, problems: ['error: <img src=x onerror=alert(1)>', ...FAIL.problems.slice(1)] });
    await runCheck(cockpit(PREVIEWS));
    expect(verdict()).toBe('Found problems');
    const items = [...card()!.querySelectorAll('li')].map((li) => li.textContent);
    expect(items).toHaveLength(6);
    expect(items[0]).toBe('error: <img src=x onerror=alert(1)>');
    expect(items[5]).toBe('2 more');
    expect(card()!.querySelectorAll('img')).toHaveLength(1);
    expect(card()!.querySelector('[onerror]')).toBeNull();
  });

  it('asks the agent to fix it by writing to this pane only', async () => {
    answer = async () => FAIL;
    const c = cockpit(PREVIEWS);
    await runCheck(c);
    act(() => [...card()!.querySelectorAll('button')].find((b) => b.textContent === 'Ask the agent to fix it')!.click());
    await flush();
    const sent = calls('pane_message_send');
    expect(sent).toHaveLength(1);
    const args = sent[0][1] as { paneId: string; text: string };
    expect(args.paneId).toBe('p1');
    expect(args.text).toContain('Please fix them');
    expect(args.text).toContain('http://localhost:5173/');
    expect(args.text).toContain('- error: Cannot read properties of undefined');
    expect(c.notify).toHaveBeenCalledWith('Sent to the agent.');
  });

  it('tells a person who must sign in what to do instead of calling it a failure', async () => {
    answer = async () => ({ ...PASS, verdict: 'sign_in', pass: false });
    await runCheck(cockpit(PREVIEWS));
    expect(verdict()).toBe('Needs you to sign in');
    expect(card()!.textContent).toContain('press Continue');
    expect(card()!.getAttribute('data-tone')).toBe('sign_in');
  });

  it('shows a plain sentence when the check cannot run, and Check again tries once more', async () => {
    answer = async () => {
      throw 'The page did not load (net::ERR_CONNECTION_REFUSED). Is the dev server running?';
    };
    await runCheck(cockpit(PREVIEWS));
    expect(verdict()).toBe('Could not check');
    expect(card()!.textContent).toContain('Is the dev server running?');
    answer = async () => PASS;
    act(() => [...card()!.querySelectorAll('button')].find((b) => b.textContent === 'Check again')!.click());
    await flush();
    expect(verdict()).toBe('Looks good');
    expect(calls('browser_check_it')).toHaveLength(2);
  });

  it('closes, and shows a working state while the page is checked', async () => {
    let finish: (r: CheckReport) => void = () => undefined;
    answer = () => new Promise<CheckReport>((resolve) => (finish = resolve));
    act(() => root.render(<PaneView c={cockpit(PREVIEWS)} paneId="p1" />));
    await flush();
    act(() => chip()!.click());
    openChat();
    await flush();
    expect(verdict()).toBe('Checking the page…');
    expect(chip()!.disabled).toBe(true);
    await act(async () => finish(PASS));
    expect(verdict()).toBe('Looks good');
    act(() => [...card()!.querySelectorAll('button')].find((b) => b.textContent === 'Close')!.click());
    expect(card()).toBeNull();
  });
});

describe('the globe button (open the browser myself)', () => {
  const globe = () => host.querySelector<HTMLButtonElement>('[data-testid="open-browser"]');

  it('is always there, even with the Labs switch off and no page to preview', async () => {
    labsOn = false;
    act(() => root.render(<PaneView c={cockpit({})} paneId="p1" />));
    await flush();
    expect(globe()).not.toBeNull();
    expect(globe()!.getAttribute('aria-label')).toBe('Open the browser');
    expect(chip()).toBeNull();
  });

  it('opens the browser window with no address, so the person types their own', async () => {
    act(() => root.render(<PaneView c={cockpit(PREVIEWS)} paneId="p1" />));
    await flush();
    act(() => globe()!.click());
    await flush();
    expect(calls('browser_open_window')).toEqual([['browser_open_window', { url: null }]]);
  });

  it('says so in a plain sentence when the window does not open', async () => {
    const c = cockpit(PREVIEWS);
    openFails = true;
    act(() => root.render(<PaneView c={c} paneId="p1" />));
    await flush();
    act(() => globe()!.click());
    await flush();
    expect(c.notify).toHaveBeenCalledWith('That is not a web address.');
  });
});
