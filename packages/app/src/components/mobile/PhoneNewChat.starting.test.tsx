// @vitest-environment jsdom
// The phone's new chat while Send is on its way: the PC is asked to warm the agent as soon as one is picked, and during the
// start the screen says "Starting… (Claude is waking up)" with the steps and the seconds, never a frozen box.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeClient, PhoneNewChatOptions } from '../../lib/bridge-types';
import { PhoneNewChat } from './PhoneNewChat';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const options: PhoneNewChatOptions = {
  agents: [
    { id: 'claude', label: 'Claude', chat: true, terminal: false },
    { id: 'codex', label: 'Codex', chat: true, terminal: false },
  ],
  projects: [{ id: 'p1', name: 'shop', state: 'repo' }],
  terminals: false,
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
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

const setValue = (el: HTMLTextAreaElement, value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

function setup() {
  let finishStart: (v: { pane_id: string; agent: string; lane: string }) => void = () => undefined;
  const phoneStartChat = vi.fn(() => new Promise<{ pane_id: string; agent: string; lane: string }>((resolve) => { finishStart = resolve; }));
  const phoneWarm = vi.fn(async () => ({ warming: true }));
  const sendPaneMessage = vi.fn(async () => ({}));
  const onStarted = vi.fn();
  const bridge = { phoneNewChat: async () => options, phoneStartChat, phoneWarm, sendPaneMessage } as unknown as BridgeClient;
  return { bridge, phoneStartChat, phoneWarm, sendPaneMessage, onStarted, finish: (v = { pane_id: 'c1', agent: 'claude', lane: 'chat' }) => finishStart(v) };
}

async function mount(h: ReturnType<typeof setup>) {
  await act(async () => {
    root.render(<PhoneNewChat bridge={h.bridge} canControl onClose={() => undefined} onStarted={h.onStarted} />);
  });
  await tick(10);
}

describe('the phone new chat starts the agent early and shows the start', () => {
  it('asks the PC to warm the picked agent and project, again only when the pick changes', async () => {
    const h = setup();
    await mount(h);
    expect(h.phoneWarm).toHaveBeenCalledTimes(1);
    expect(h.phoneWarm).toHaveBeenCalledWith({ agent: 'claude', project: 'p1' });
    const codex = Array.from(host.querySelectorAll('[data-testid="nc-agent-tile"]')).find((b) => b.textContent?.includes('Codex')) as HTMLElement;
    await act(async () => { codex.click(); });
    expect(h.phoneWarm).toHaveBeenCalledTimes(2);
    expect(h.phoneWarm).toHaveBeenLastCalledWith({ agent: 'codex', project: 'p1' });
  });

  it('does not ask without the right to start chats', async () => {
    const h = setup();
    await act(async () => {
      root.render(<PhoneNewChat bridge={h.bridge} canControl={false} onClose={() => undefined} onStarted={h.onStarted} />);
    });
    await tick(10);
    expect(h.phoneWarm).not.toHaveBeenCalled();
  });

  it('says "Starting… (Claude is waking up)" with steps and seconds while the PC starts, then sends the first message', async () => {
    const h = setup();
    await mount(h);
    await setValue(host.querySelector('textarea') as HTMLTextAreaElement, 'fix the login page');
    await act(async () => { (host.querySelector('button[type="submit"]') as HTMLElement).click(); });
    const box = host.querySelector('[data-testid="nc-starting"]');
    expect(box?.textContent).toContain('Starting… (Claude is waking up)');
    expect(box?.textContent).toContain('Waking up Claude');
    expect(box?.textContent).toContain('Sending your message');
    expect(box?.textContent).not.toContain('Still waking up');
    await tick(3000);
    expect(host.querySelector('[data-testid="nc-starting"]')?.textContent).toContain('3 s');
    await tick(4000);
    expect(host.querySelector('[data-testid="nc-starting"]')?.textContent).toContain('Still waking up');
    // The PC answers: the first step is ticked, the message goes, the chat opens.
    await act(async () => { h.finish(); });
    await tick(10);
    expect(h.sendPaneMessage).toHaveBeenCalledWith('c1', 'fix the login page');
    expect(h.onStarted).toHaveBeenCalledWith('c1', 'chat', true);
    expect(host.querySelector('[data-testid="nc-starting"]')).toBeNull();
  });

  it('brings the picker back when the start fails', async () => {
    const h = setup();
    h.bridge.phoneStartChat = vi.fn(async () => { throw new Error('bridge POST /phone/chats -> 502: The agent could not start.'); }) as never;
    await mount(h);
    await setValue(host.querySelector('textarea') as HTMLTextAreaElement, 'hi');
    await act(async () => { (host.querySelector('button[type="submit"]') as HTMLElement).click(); });
    await tick(10);
    expect(host.querySelector('[data-testid="nc-starting"]')).toBeNull();
    expect(host.querySelector('[data-testid="nc-tiles"]')).not.toBeNull();
    expect(h.onStarted).not.toHaveBeenCalled();
  });
});
