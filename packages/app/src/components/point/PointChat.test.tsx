// @vitest-environment jsdom
// Point and Fix with chat agents (N5-21): the chat shows by its task name and is the default, Send goes through the
// one send call, the picture shows in the sent chat message (thumbnail, click to enlarge), and the before and
// after strip appears in the box after the agent's turn.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import type { PickView, PointState, Target } from '../../lib/point-api';
import type { pointApi } from '../../lib/point-api';
import type { ChatAttachment } from '../../lib/attachFiles';
import { groupTurns, type ChatItem } from '../../lib/sessionChat';
import { SessionChatView, type SessionChatViewProps } from '../chat/SessionChatView';
import { PointBoxApp } from './PointBoxApp';
import { targetLabel } from './point-model';
import { setLanguagePref } from '../../i18n';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PICK: PickView = {
  id: 'pick-1',
  page: 'localhost:5173',
  title: 'Sample',
  label: 'button.buy',
  text: 'Buy',
  thumb: 'data:image/png;base64,AAAA',
};
const CHAT: Target = { paneId: 'chat1', agentLabel: 'Claude', title: 'Fix the buy button', sameFolder: true, canSend: true, chat: true };
const TERM: Target = { paneId: 'term1', agentLabel: 'Codex', title: 'old-terminal', sameFolder: true, canSend: true };
const STATE: PointState = { picks: [PICK], targets: [CHAT, TERM], defaultTarget: 'chat1', notice: null, session: 1 };

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue('data:image/png;base64,AAAA');
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  setLanguagePref('en');
});

const flush = () => act(async () => { await new Promise((r) => setImmediate(r)); });

function fakeApi(initial: PointState) {
  let cb: ((s: PointState) => void) | null = null;
  let shell = initial;
  return {
    state: vi.fn(async () => shell),
    send: vi.fn(async () => {
      shell = { ...shell, picks: [], session: null };
      return {};
    }),
    compose: vi.fn(),
    editInChat: vi.fn(),
    arm: vi.fn(),
    removePick: vi.fn(),
    discard: vi.fn(),
    hide: vi.fn().mockResolvedValue(undefined),
    openBlockedLink: vi.fn(),
    recheckRun: vi.fn().mockResolvedValue(undefined),
    recheckDismiss: vi.fn().mockResolvedValue(undefined),
    onState: vi.fn((f: (s: PointState) => void) => {
      cb = f;
      return () => {};
    }),
    onDraft: vi.fn(() => () => {}),
    push: (s: PointState) => cb?.(s),
  };
}

async function renderApp(api: ReturnType<typeof fakeApi>) {
  await act(async () => {
    root.render(<PointBoxApp api={api as unknown as typeof pointApi} />);
  });
  await flush();
}

describe('the To list with chat agents', () => {
  it('names a chat by its task first and a terminal by its agent first', () => {
    expect(targetLabel(CHAT)).toBe('Fix the buy button · Claude');
    expect(targetLabel(TERM)).toBe('Codex · old-terminal');
  });

  it('shows the chat by its task name, picks it as the default, and says the picture is attached', async () => {
    const api = fakeApi(STATE);
    await renderApp(api);
    const select = host.querySelector('select') as HTMLSelectElement;
    expect(select.value).toBe('chat1');
    expect(Array.from(select.options).map((o) => o.textContent)).toContain('Fix the buy button · Claude');
    expect(host.textContent).toContain('A chat gets the picture attached to the message.');
  });

  it('sends to the chat with the one send call (the shell adds the picture)', async () => {
    const api = fakeApi(STATE);
    await renderApp(api);
    const area = host.querySelector('textarea') as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(area, 'Make it green');
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    await flush();
    expect(api.send).toHaveBeenCalledWith('chat1', 'Make it green');
  });

  it('is translated to zh-TW', async () => {
    setLanguagePref('zh-TW');
    const api = fakeApi(STATE);
    await renderApp(api);
    expect(host.textContent).toContain('指出並修正');
    expect(host.textContent).toContain('要改什麼？');
    expect(host.textContent).toContain('對話會把圖片附在訊息上。');
  });
});

describe('the sent chat message shows the screenshot', () => {
  const SHOT: ChatAttachment = { name: 'pick-20261115-000000-1.png', path: '/proj/.potato-workspace/attachments/1-pick.png', kind: 'image', size: 2048, mime: 'image/png' };
  const items: ChatItem[] = [
    { kind: 'user', id: '10:0', at: null, text: 'Please change this in the app: Make it green\n\n- Screenshot: attached to this message (pick-20261115-000000-1.png)', attachments: [SHOT] } as ChatItem,
    { kind: 'assistant', id: '20:0', at: null, text: 'Done.', model: null, finalAnswer: true },
    { kind: 'turnEnd', id: '30:0', at: null, outcome: 'completed', durationMs: 1000 },
  ];

  it('has a thumbnail chip that opens a larger view', async () => {
    const props: SessionChatViewProps = { state: 'ready', reason: null, turns: groupTurns(items).turns, model: null, cliVersion: null };
    act(() => root.render(<SessionChatView {...props} />));
    await flush();
    const chip = host.querySelector('[data-testid="attachment-chip"][data-kind="image"]');
    expect(chip).not.toBeNull();
    expect(chip!.querySelector('img')).not.toBeNull();
    act(() => (chip!.querySelector('button.ck-att-thumb') as HTMLButtonElement).click());
    await flush();
    expect(document.querySelector('[data-testid="attachment-preview"]')).not.toBeNull();
  });
});

describe('Check it again', () => {
  const RECHECK: PointState = {
    picks: [],
    targets: [CHAT],
    defaultTarget: 'chat1',
    notice: null,
    session: null,
    recheck: { agent: 'Claude · Fix the buy button', label: 'button.buy', before: 'data:image/png;base64,BBBB', after: 'data:image/png;base64,CCCC', note: null, busy: false },
  };

  it('shows the before and after strip when the shell offers one, in place of the empty form', async () => {
    const api = fakeApi({ ...STATE, picks: [], session: null });
    await renderApp(api);
    expect(host.querySelector('[data-testid="recheck-strip"]')).toBeNull();
    act(() => api.push(RECHECK));
    expect(host.querySelector('[data-testid="recheck-strip"]')).not.toBeNull();
    const imgs = Array.from(host.querySelectorAll('[data-testid="recheck-strip"] img')).map((i) => i.getAttribute('src'));
    expect(imgs).toEqual(['data:image/png;base64,BBBB', 'data:image/png;base64,CCCC']);
    expect(host.textContent).toContain('Claude · Fix the buy button finished. The preview was reloaded.');
    expect(host.querySelector('textarea')).toBeNull();
  });

  it('a click enlarges a picture and Check again and Close call the shell', async () => {
    const api = fakeApi({ ...STATE, picks: [], session: null });
    await renderApp(api);
    act(() => api.push(RECHECK));
    act(() => (host.querySelector('[data-testid="recheck-after"] button') as HTMLButtonElement).click());
    expect(host.querySelector('.point-recheck-big img')?.getAttribute('src')).toBe('data:image/png;base64,CCCC');
    act(() => (host.querySelector('.point-recheck-big') as HTMLElement).click());
    expect(host.querySelector('.point-recheck-big')).toBeNull();
    const byText = (t: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent === t) as HTMLButtonElement;
    act(() => byText('Check again').click());
    expect(api.recheckRun).toHaveBeenCalledTimes(1);
    act(() => byText('Close').click());
    expect(api.recheckDismiss).toHaveBeenCalledTimes(1);
  });

  it('says when there is no picture, and keeps Check again off while it runs', async () => {
    const api = fakeApi({ ...STATE, picks: [], session: null });
    await renderApp(api);
    act(() => api.push({ ...RECHECK, recheck: { ...RECHECK.recheck!, before: null, after: null, busy: true, note: null } }));
    expect(host.textContent).toContain('No picture from before');
    expect(host.textContent).toContain('Looking at the page again');
    const again = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Check again') as HTMLButtonElement;
    expect(again.disabled).toBe(true);
  });
});
