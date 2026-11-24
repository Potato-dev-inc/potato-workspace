// @vitest-environment jsdom
// Closing a chat of another PC from its row: it asks first when the agent is working or a message is written and not sent; otherwise it closes.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import { fakeAcpApi } from '../../lib/acpChatFake';
import { writeDraft } from '../../lib/composerDraft';
import { requestPaneAction } from '../../lib/pane-actions';
import { useEnglish } from '../../i18n/test-utils';
import { PaneView } from './PaneView';

const invoke = vi.fn(async (cmd: string) => (cmd === 'checkpoints_list' ? { state: 'ok', message: '', items: [] } : cmd === 'get_app_install_info' ? { platform: 'windows' } : null));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => (invoke as (...x: unknown[]) => unknown)(...(a as [string])) }));
vi.mock('../TerminalViewport', () => ({ TerminalViewport: () => <div data-testid="term" /> }));
vi.mock('../../lib/sessionChat', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/sessionChat')>()),
  openSessionChat: vi.fn(async () => ({ available: true, reason: null, source: 'acp', items: [] })),
  closeSessionChat: vi.fn(async () => undefined),
  onSessionChatItems: vi.fn(async () => () => undefined),
  onSessionChatStatus: vi.fn(async () => () => undefined),
  onSessionChatSource: vi.fn(async () => () => undefined),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
Element.prototype.scrollIntoView = () => {};

const KEY = 'dev:n1:p1';
function cockpit(status: string) {
  const info = { id: KEY, agent_type: 'claude', status, pid: 0, created_at: 1, last_output_at: null, cwd: '/work', cols: 100, rows: 30, lane: 'acp' };
  const p = { status, info };
  const closePane = vi.fn();
  const c = { registry: { paneList: [p], panes: new Map([[KEY, p]]), initialReady: true }, names: new Map([[KEY, 'Claude']]), activities: {}, previews: {}, asked: { questions: [], answerQuestion: vi.fn(), dismissQuestion: vi.fn() }, prompts: {}, statusSince: new Map(), now: 12_000, selectedId: KEY, mode: 'orchestration', select: vi.fn(), notify: vi.fn(), answer: vi.fn(), closePane } as unknown as CockpitApi;
  return { c, closePane };
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  useEnglish();
  window.localStorage.clear();
  (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
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
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === text);
async function close(status: string) {
  const { c, closePane } = cockpit(status);
  await act(async () => root.render(<PaneView c={c} paneId={KEY} acp={fakeAcpApi()} />));
  await flush();
  await act(async () => requestPaneAction(KEY, 'close'));
  await flush();
  return closePane;
}

describe('closing a far chat from its row', () => {
  it('closes at once when it is idle and nothing is written', async () => {
    expect(await close('idle')).toHaveBeenCalledWith(KEY);
  });
  it('asks first while the agent is working', async () => {
    const closePane = await close('running');
    expect(closePane).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('still running');
    await act(async () => button('Close agent')!.click());
    expect(closePane).toHaveBeenCalledWith(KEY);
  });
  it('asks first when a message is written and not sent', async () => {
    writeDraft(KEY, 'half a thought');
    const closePane = await close('idle');
    expect(closePane).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('was not sent');
    await act(async () => button('Keep open')!.click());
    expect(closePane).not.toHaveBeenCalled();
  });
});
