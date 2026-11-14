// @vitest-environment jsdom
// Phone part 2 in the chat screen: the PC cannot be reached (P18), Stop (P9), and an agent the PC keeps phones out of (P20).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeClient } from '../../lib/bridge-types';
import type { LinkKind } from '../../lib/phone-link';
import type { RuleLimit } from '../../lib/pane-rule-view';
import type { OutboxMessage } from '../../lib/paneOutbox';
import type { ChatItem, PhoneChatReply } from '../../lib/sessionChatModel';
import { PhoneChatView } from './PhoneChatView';
import { STOPPED_BAR_MS } from './PhoneStoppedBar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
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
const chat: PhoneChatReply = { available: true, reason: null, source: 'file', waitingFor: null, rev: 1, reset: false, items: [user('1:0', 'fix the login page')] };
const sent = (text: string): OutboxMessage => ({ id: 'm1', text, createdAt: 1, state: 'queued', waitingFor: null, error: null });

function makeBridge(over: Partial<BridgeClient> = {}) {
  const sendPaneMessage = vi.fn(async (_pane: string, text: string) => sent(text));
  const interruptPane = vi.fn(async (pane: string) => ({ pane_id: pane, stopped: true }));
  const askControl = vi.fn(async () => ({ asked: true }));
  const bridge = {
    paneChat: vi.fn(async () => chat),
    sendPaneMessage,
    listPaneMessages: vi.fn(async () => [] as OutboxMessage[]),
    cancelPaneMessage: vi.fn(),
    interruptPane,
    askControl,
    ...over,
  } as unknown as BridgeClient;
  return { bridge, sendPaneMessage, interruptPane, askControl };
}

async function mount(props: { bridge: BridgeClient; link?: LinkKind; working?: boolean; ruleLimit?: RuleLimit | null }) {
  await act(async () => {
    root.render(<PhoneChatView bridge={props.bridge} paneId="p1" canWatch canType link={props.link} working={props.working} ruleLimit={props.ruleLimit ?? null} />);
  });
}
const text = () => host.textContent ?? '';
const field = () => host.querySelector('textarea') as HTMLTextAreaElement;
function type(value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    set.call(field(), value);
    field().dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const submit = async () => act(async () => { (host.querySelector('button[type="submit"]') as HTMLButtonElement).click(); await Promise.resolve(); });
const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label || b.getAttribute('aria-label') === label) as HTMLButtonElement | undefined;

describe('P18: when the PC cannot be reached', () => {
  it('keeps the last chat readable, greyed, with the time it was read', async () => {
    const { bridge } = makeBridge();
    await mount({ bridge });
    expect(host.querySelector('[data-testid="phone-asof"]')).toBeNull();
    await mount({ bridge, link: 'asleep' });
    expect(text()).toContain('fix the login page');
    expect(host.querySelector('[data-testid="phone-conversation"]')?.getAttribute('data-stale')).toBe('true');
    expect(host.querySelector('[data-testid="phone-asof"]')?.textContent).toMatch(/^As of \d/);
  });

  it('a message typed while away waits on the phone and is not sent', async () => {
    const { bridge, sendPaneMessage } = makeBridge();
    await mount({ bridge, link: 'offline' });
    type('please also add a test');
    await submit();
    expect(sendPaneMessage).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="phone-queue-waiting"] [role="status"]')?.textContent).toBe('1 message is waiting for your PC.');
    expect(field().value).toBe('');
  });

  it('when the PC is back it asks before sending, and Send sends', async () => {
    const { bridge, sendPaneMessage } = makeBridge();
    await mount({ bridge, link: 'offline' });
    type('please also add a test');
    await submit();
    await mount({ bridge, link: 'connected' });
    const ask = host.querySelector('[data-testid="phone-queue-ask"]');
    expect(ask?.textContent).toContain('Your PC is back. Send the message you wrote while it was away?');
    expect(sendPaneMessage).not.toHaveBeenCalled();
    await act(async () => { button('Send')!.click(); await Promise.resolve(); });
    expect(sendPaneMessage).toHaveBeenCalledWith('p1', 'please also add a test');
    expect(host.querySelector('[data-testid="phone-queue-ask"]')).toBeNull();
  });

  it('Delete throws the waiting message away without sending it', async () => {
    const { bridge, sendPaneMessage } = makeBridge();
    await mount({ bridge, link: 'asleep' });
    type('never mind');
    await submit();
    await mount({ bridge, link: 'connected' });
    act(() => button('Delete')!.click());
    expect(host.querySelector('[data-testid="phone-queue-ask"]')).toBeNull();
    expect(sendPaneMessage).not.toHaveBeenCalled();
    expect(localStorage.getItem('pm.phone.queue.p1')).toBeNull();
  });
});

describe('P9: Stop', () => {
  it('Send is Stop while the agent works and nothing is typed', async () => {
    const { bridge } = makeBridge();
    await mount({ bridge, working: true });
    expect(host.querySelector('[data-testid="phone-stop"]')).not.toBeNull();
    expect(host.querySelector('button[type="submit"]')).toBeNull();
    // Typing brings Send back: a follow-up is still possible.
    type('and then the footer');
    expect(host.querySelector('[data-testid="phone-stop"]')).toBeNull();
    expect(host.querySelector('button[type="submit"]')).not.toBeNull();
  });

  it('is plain Send when the agent is not working', async () => {
    const { bridge } = makeBridge();
    await mount({ bridge, working: false });
    expect(host.querySelector('[data-testid="phone-stop"]')).toBeNull();
  });

  it('stops through the bridge, then says Stopped with Continue for 10 seconds', async () => {
    const { bridge, interruptPane, sendPaneMessage } = makeBridge();
    await mount({ bridge, working: true });
    await act(async () => { (host.querySelector('[data-testid="phone-stop"]') as HTMLButtonElement).click(); await Promise.resolve(); });
    expect(interruptPane).toHaveBeenCalledWith('p1');
    const bar = host.querySelector('[data-testid="phone-stopped-bar"]');
    expect(bar?.textContent).toContain('Stopped');
    await act(async () => { button('Continue')!.click(); await Promise.resolve(); });
    expect(sendPaneMessage).toHaveBeenCalledWith('p1', 'Please continue.');
    expect(host.querySelector('[data-testid="phone-stopped-bar"]')).toBeNull();
  });

  it('the Stopped bar goes by itself after 10 seconds', async () => {
    const { bridge } = makeBridge();
    await mount({ bridge, working: true });
    await act(async () => { (host.querySelector('[data-testid="phone-stop"]') as HTMLButtonElement).click(); await Promise.resolve(); });
    expect(host.querySelector('[data-testid="phone-stopped-bar"]')).not.toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(STOPPED_BAR_MS + 50); });
    expect(host.querySelector('[data-testid="phone-stopped-bar"]')).toBeNull();
  });

  it('says so when the PC refuses the stop', async () => {
    const { bridge } = makeBridge({ interruptPane: vi.fn(async () => { throw new Error('bridge POST /panes/p1/interrupt -> 403: no'); }) } as Partial<BridgeClient>);
    await mount({ bridge, working: true });
    await act(async () => { (host.querySelector('[data-testid="phone-stop"]') as HTMLButtonElement).click(); await Promise.resolve(); });
    expect(text()).toContain('This phone may not stop this agent.');
    expect(host.querySelector('[data-testid="phone-stopped-bar"]')).toBeNull();
  });
});

describe('P20: an agent the PC keeps phones out of', () => {
  it('replaces the box with one sentence and Ask the PC for control', async () => {
    const { bridge } = makeBridge();
    await mount({ bridge, ruleLimit: 'watch' });
    expect(host.querySelector('textarea')).toBeNull();
    expect(host.querySelector('[data-testid="phone-no-control"]')?.textContent).toContain('You can watch this agent. Your PC does not let phones type to it.');
    expect(button('Ask the PC for control')).toBeDefined();
  });

  it('says the phones are off when the agent is switched off', async () => {
    const { bridge } = makeBridge();
    await mount({ bridge, ruleLimit: 'off' });
    expect(text()).toContain('Phones are switched off for this agent on your PC.');
  });

  it('asks the PC once and then waits for a person there', async () => {
    const { bridge, askControl } = makeBridge();
    await mount({ bridge, ruleLimit: 'watch' });
    await act(async () => { button('Ask the PC for control')!.click(); await Promise.resolve(); });
    expect(askControl).toHaveBeenCalledWith('p1');
    expect(text()).toContain('Asked. Waiting for someone at your PC to say yes.');
    expect(button('Ask the PC for control')!.disabled).toBe(true);
  });

  it('tells a second ask within 5 minutes to wait', async () => {
    const { bridge } = makeBridge({ askControl: vi.fn(async () => { throw new Error('bridge POST /control-asks -> 429: {"code":"ASKED_RECENTLY"}'); }) } as Partial<BridgeClient>);
    await mount({ bridge, ruleLimit: 'watch' });
    await act(async () => { button('Ask the PC for control')!.click(); await Promise.resolve(); });
    expect(text()).toContain('You asked a moment ago. Try again in a few minutes.');
    expect(button('Ask the PC for control')!.disabled).toBe(false);
  });

  it('the box comes back by itself when the rule lets the phone type again', async () => {
    const { bridge } = makeBridge();
    await mount({ bridge, ruleLimit: 'watch' });
    expect(host.querySelector('textarea')).toBeNull();
    await mount({ bridge, ruleLimit: null });
    expect(host.querySelector('textarea')).not.toBeNull();
    expect(host.querySelector('[data-testid="phone-no-control"]')).toBeNull();
  });
});
