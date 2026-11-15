// @vitest-environment jsdom
// The phone's side of three chat features, through the bridge (the PC makes the same checks): a picture the agent names is shown
// and opens large, "Show earlier messages" puts older messages in front, and the half-written message follows the person.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeClient } from '../../lib/bridge-types';
import type { OutboxMessage } from '../../lib/paneOutbox';
import type { ChatItem, PhoneChatReply } from '../../lib/sessionChatModel';
import { clearPictureCache } from '../chat/ChatPicture';
import { PhoneChatView } from './PhoneChatView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  clearPictureCache();
  vi.useFakeTimers();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const user = (id: string, text: string): ChatItem => ({ kind: 'user', id, at: null, text });
const reply = (items: ChatItem[]): PhoneChatReply => ({ available: true, reason: null, source: 'acp', waitingFor: null, rev: 1, reset: false, items });
const DOT = 'data:image/png;base64,iVBORw0KGgo=';

function makeBridge(items: ChatItem[], over: Partial<BridgeClient> = {}) {
  const bridge = {
    paneChat: vi.fn(async () => reply(items)),
    sendPaneMessage: vi.fn(async (_pane: string, text: string) => ({ id: 'm1', text, createdAt: 1, state: 'queued', waitingFor: null, error: null }) as OutboxMessage),
    listPaneMessages: vi.fn(async () => [] as OutboxMessage[]),
    cancelPaneMessage: vi.fn(),
    ...over,
  } as unknown as BridgeClient;
  return bridge;
}

async function mount(bridge: BridgeClient, canType = true) {
  await act(async () => {
    root.render(<PhoneChatView bridge={bridge} paneId="p1" canWatch canType={canType} acp />);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(50);
  });
}
const text = () => host.textContent ?? '';
const field = () => host.querySelector('textarea') as HTMLTextAreaElement;

describe('pictures in the phone chat', () => {
  const answer: ChatItem = { kind: 'assistant', id: 'a1', at: null, text: 'Here is the chart: ![sales chart](<out/chart.png>)', model: null, finalAnswer: true };

  it('asks the PC for the picture the answer names and draws it, and a tap opens it large', async () => {
    const panePicture = vi.fn(async () => ({ name: 'chart.png', mime: 'image/png', size: 8, dataUrl: DOT }));
    await mount(makeBridge([user('u1', 'make a chart'), answer], { panePicture }));
    expect(panePicture).toHaveBeenCalledWith('p1', 'out/chart.png');
    const img = host.querySelector<HTMLImageElement>('[data-testid="chat-picture"] img')!;
    expect(img.getAttribute('src')).toBe(DOT);
    expect(img.getAttribute('alt')).toBe('sales chart');
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="chat-picture"]')!.click());
    expect(document.querySelector('[data-testid="chat-picture-big"] img')!.getAttribute('src')).toBe(DOT);
    await act(async () => document.querySelector<HTMLElement>('[data-testid="chat-picture-big"]')!.click());
    expect(document.querySelector('[data-testid="chat-picture-big"]')).toBeNull();
  });

  it('says in one sentence when the PC refuses the picture (it is outside the project)', async () => {
    const panePicture = vi.fn(async () => {
      throw new Error('GET /panes/p1/picture -> 404: PICTURE_NOT_IN_PROJECT: That picture is not in this project, so it is not shown.');
    });
    await mount(makeBridge([user('u1', 'x'), answer], { panePicture }));
    expect(host.querySelector('[data-testid="chat-picture"]')).toBeNull();
    expect(host.querySelector('[data-testid="chat-picture-refused"]')!.textContent).toContain('not in this project');
  });

  it('an old PC with no picture route shows only the words', async () => {
    await mount(makeBridge([user('u1', 'x'), answer]));
    expect(host.querySelector('[data-testid="chat-picture"]')).toBeNull();
    expect(text()).toContain('[sales chart]');
  });
});

describe('Show earlier messages on the phone', () => {
  const held = [user('u50', 'message 50'), { kind: 'assistant', id: 'a50', at: null, text: 'answer 50', model: null, finalAnswer: true } as ChatItem, { kind: 'turnEnd', id: 'e50', at: null, outcome: 'completed', durationMs: 1 } as ChatItem];

  it('shows the row only when the PC says there is more, loads a page, and the row goes when nothing is left', async () => {
    const paneChatEarlier = vi.fn(async (_pane: string, _before: string, limit?: number) =>
      limit === 0 ? { items: [], more: true } : { items: [user('u40', 'message 40')], more: false },
    );
    await mount(makeBridge(held, { paneChatEarlier }));
    expect(paneChatEarlier).toHaveBeenCalledWith('p1', 'u50', 0);
    const row = host.querySelector<HTMLButtonElement>('[data-testid="show-earlier"] button')!;
    expect(row.textContent).toBe('Show earlier messages');
    expect(text()).not.toContain('message 40');
    await act(async () => row.click());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(paneChatEarlier).toHaveBeenCalledWith('p1', 'u50', 50);
    const body = host.textContent ?? '';
    expect(body.indexOf('message 40')).toBeGreaterThan(-1);
    expect(body.indexOf('message 40')).toBeLessThan(body.indexOf('message 50'));
    expect(host.querySelector('[data-testid="show-earlier"]')).toBeNull();
  });

  it('shows no row when the chat has nothing earlier, or the PC cannot page', async () => {
    const none = vi.fn(async () => ({ items: [], more: false }));
    await mount(makeBridge(held, { paneChatEarlier: none }));
    expect(none).toHaveBeenCalled();
    expect(host.querySelector('[data-testid="show-earlier"]')).toBeNull();
  });

  it('a press that fails says so and can be tried again', async () => {
    let fail = true;
    const paneChatEarlier = vi.fn(async (_pane: string, _before: string, limit?: number) => {
      if (limit === 0) return { items: [], more: true };
      if (fail) throw new Error('GET -> 500');
      return { items: [user('u40', 'message 40')], more: false };
    });
    await mount(makeBridge(held, { paneChatEarlier }));
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="show-earlier"] button')!.click());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(host.querySelector('[data-testid="show-earlier"]')!.textContent).toContain('Could not load earlier messages.');
    fail = false;
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="show-earlier"] button')!.click());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(text()).toContain('message 40');
  });
});

describe('your draft follows you on the phone', () => {
  const draftBridge = (remote: string, over: Partial<BridgeClient> = {}) => {
    const paneDraft = vi.fn(async () => ({ text: remote, at: 1 }));
    const setPaneDraft = vi.fn(async (_pane: string, words: string) => ({ text: words, at: 2 }));
    return { bridge: makeBridge([user('u1', 'hi')], { paneDraft, setPaneDraft, ...over }), paneDraft, setPaneDraft };
  };

  it('an empty box takes the draft the PC holds', async () => {
    const { bridge, paneDraft } = draftBridge('half a message from my PC');
    await mount(bridge);
    expect(paneDraft).toHaveBeenCalledWith('p1');
    expect(field().value).toBe('half a message from my PC');
  });

  it('a box that already has text is not replaced', async () => {
    localStorage.setItem('pm.composerDrafts', JSON.stringify({ p1: { text: 'what I was typing here', at: Date.now() } }));
    const { bridge } = draftBridge('half a message from my PC');
    await mount(bridge);
    expect(field().value).toBe('what I was typing here');
  });

  it('typing is written to the PC a moment later, as words only', async () => {
    const { bridge, setPaneDraft } = draftBridge('');
    await mount(bridge);
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => {
      set.call(field(), 'typed on the phone');
      field().dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(setPaneDraft).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(900);
    });
    expect(setPaneDraft).toHaveBeenCalledWith('p1', 'typed on the phone');
    expect(setPaneDraft.mock.calls.every((call) => call.length === 2 && typeof call[1] === 'string')).toBe(true);
  });

  it('a PC that has no draft route changes nothing', async () => {
    await mount(makeBridge([user('u1', 'hi')]));
    expect(field().value).toBe('');
  });
});
