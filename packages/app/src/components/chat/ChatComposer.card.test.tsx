// @vitest-environment jsdom
// The message box as one card: text, then a footer line with the + button, the agent settings, the context ring and
// the send button (a Stop square while the agent works).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatComposer } from './ChatComposer';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const onSend = async (): Promise<string | null> => null;
const reading = { used: 82_000, window: 200_000, percent: 41, input: 80_000, output: 2000 };
const foot = () => host.querySelector<HTMLElement>('.ck-chat-composer-foot')!;

describe('ChatComposer card', () => {
  it('puts the text first and the footer line after it, with the + button, settings, ring and send in that order', () => {
    act(() =>
      root.render(
        <ChatComposer onSend={onSend} blockedReason={null} draftKey="p1" attachFiles={async () => []} toolbar={<span data-testid="tb">settings</span>} contextUsage={reading} />,
      ),
    );
    const row = host.querySelector('.ck-chat-composer-row')!;
    const kids = [...row.children];
    expect(kids[0].tagName).toBe('TEXTAREA');
    expect(kids[kids.length - 1]).toBe(foot());
    const order = [...foot().querySelectorAll('[data-testid="chat-composer-attach"], [data-testid="tb"], [data-testid="context-meter"], button[type="submit"]')].map((el) => el.getAttribute('data-testid') ?? 'send');
    expect(order).toEqual(['chat-composer-attach', 'tb', 'context-meter', 'send']);
  });

  it('shows the ring only when there is a reading', () => {
    act(() => root.render(<ChatComposer onSend={onSend} blockedReason={null} />));
    expect(host.querySelector('[data-testid="context-meter"]')).toBeNull();
    act(() => root.render(<ChatComposer onSend={onSend} blockedReason={null} contextUsage={reading} />));
    expect(host.querySelector('[aria-label="Context 41% used"]')).not.toBeNull();
  });

  const typeText = (value: string) => {
    const field = host.querySelector('textarea')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  it('becomes a filled Stop button while the agent works, and Stop stops', () => {
    const onStop = vi.fn();
    act(() => root.render(<ChatComposer onSend={onSend} blockedReason={null} running onStop={onStop} />));
    const stop = host.querySelector<HTMLButtonElement>('[data-testid="chat-composer-stop"]')!;
    expect(stop.getAttribute('aria-label')).toBe('Stop');
    expect(stop.classList.contains('ck-btn--primary')).toBe(true);
    expect(stop.classList.contains('ck-chat-send')).toBe(true);
    expect(host.querySelector('button[type="submit"]')).toBeNull();
    act(() => stop.click());
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('with text typed while the agent works the arrow is back (it queues) and a small Stop stays beside it', () => {
    const onStop = vi.fn();
    act(() => root.render(<ChatComposer onSend={onSend} blockedReason={null} running onStop={onStop} />));
    typeText('then also run the tests');
    const send = host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(send.disabled).toBe(false);
    const stop = host.querySelector<HTMLButtonElement>('[data-testid="chat-composer-stop"]')!;
    expect(stop.classList.contains('ck-chat-stop-mini')).toBe(true);
    act(() => stop.click());
    expect(onStop).toHaveBeenCalledTimes(1);
    // Emptying the box brings the big Stop back.
    typeText('');
    expect(host.querySelector('button[type="submit"]')).toBeNull();
    expect(host.querySelector('[data-testid="chat-composer-stop"]')!.classList.contains('ck-chat-send')).toBe(true);
  });

  it('Send while the agent works queues the text (onSend), it does not stop the agent', async () => {
    const send = vi.fn(async () => null);
    const onStop = vi.fn();
    act(() => root.render(<ChatComposer onSend={send} blockedReason={null} running onStop={onStop} />));
    typeText('queue this');
    await act(async () => host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    expect(send).toHaveBeenCalledWith('queue this');
    expect(onStop).not.toHaveBeenCalled();
  });

  it('says what the agent does quietly in the footer, and reads Stopping… with the button off', () => {
    act(() => root.render(<ChatComposer onSend={onSend} blockedReason={null} running onStop={() => undefined} status={{ text: 'Working…', stopping: false }} />));
    const status = host.querySelector('[data-testid="chat-composer-status"]')!;
    expect(status.textContent).toBe('Working…');
    expect(foot().contains(status)).toBe(true);
    expect(status.hasAttribute('data-stopping')).toBe(false);
    act(() => root.render(<ChatComposer onSend={onSend} blockedReason={null} running onStop={() => undefined} status={{ text: 'Stopping…', stopping: true }} />));
    expect(host.querySelector('[data-testid="chat-composer-status"]')!.textContent).toBe('Stopping…');
    expect(host.querySelector<HTMLButtonElement>('[data-testid="chat-composer-stop"]')!.disabled).toBe(true);
  });

  it('idle: the send button is a disabled round button, not missing', () => {
    act(() => root.render(<ChatComposer onSend={onSend} blockedReason={null} />));
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    expect(host.querySelector('[data-testid="chat-composer-status"]')).toBeNull();
  });

  it('Esc in the box still stops the agent while a settings control sits in the footer', () => {
    const onStop = vi.fn();
    const toolbar = (
      <div>
        <button type="button" aria-label="Pick" aria-haspopup="listbox" />
      </div>
    );
    act(() => root.render(<ChatComposer onSend={onSend} blockedReason={null} running onStop={onStop} toolbar={toolbar} />));
    const field = host.querySelector('textarea')!;
    act(() => {
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});
