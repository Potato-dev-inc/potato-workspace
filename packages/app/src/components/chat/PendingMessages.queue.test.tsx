// @vitest-environment jsdom
// The waiting messages read as a short stacked queue: numbered rows in order, each with its own Send now and Cancel.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OutboxMessage } from '../../lib/paneOutbox';
import { PendingMessages } from './PendingMessages';

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

const BUSY = 'The agent is working. Sends when the turn ends.';
const message = (id: string, text: string, over: Partial<OutboxMessage> = {}): OutboxMessage => ({ id, text, createdAt: 1, state: 'queued', waitingFor: BUSY, error: null, ...over });

describe('the message queue', () => {
  it('stacks the waiting messages in order, numbered, with the full text on hover', () => {
    act(() => root.render(<PendingMessages messages={[message('a', 'first one'), message('b', 'second one')]} onCancel={vi.fn()} onHide={vi.fn()} onSendNow={vi.fn()} />));
    const rows = [...host.querySelectorAll('[data-testid="chat-pending"]')];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.querySelector('.ck-q-n')!.textContent)).toEqual(['1', '2']);
    expect(rows.map((r) => r.querySelector('.ck-chat-bubble--pending')!.getAttribute('title'))).toEqual(['first one', 'second one']);
  });

  it('keeps Send now and Cancel on every row, each for its own message', async () => {
    const onCancel = vi.fn(async (): Promise<string | null> => null);
    const onSendNow = vi.fn();
    act(() => root.render(<PendingMessages messages={[message('a', 'first one'), message('b', 'second one')]} onCancel={onCancel} onHide={vi.fn()} onSendNow={onSendNow} />));
    const rows = [...host.querySelectorAll('[data-testid="chat-pending"]')];
    const buttons = (row: Element, label: string) => [...row.querySelectorAll('button')].filter((b) => b.textContent === label);
    expect(rows.every((r) => buttons(r, 'Send now').length === 1 && buttons(r, 'Remove').length === 1)).toBe(true);
    await act(async () => buttons(rows[1], 'Remove')[0].click());
    expect(onCancel).toHaveBeenCalledWith('b');
    act(() => buttons(rows[0], 'Send now')[0].click());
    expect(onSendNow).toHaveBeenCalledTimes(1);
  });

  it('a failed message keeps its error, Copy text and Hide', () => {
    const onHide = vi.fn();
    act(() => root.render(<PendingMessages messages={[message('a', 'oops', { state: 'failed', waitingFor: null, error: 'Could not send.' })]} onCancel={vi.fn()} onHide={onHide} />));
    expect(host.querySelector('[data-testid="chat-pending-error"]')!.textContent).toBe('Could not send.');
    const hide = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Hide')!;
    act(() => hide.click());
    expect(onHide).toHaveBeenCalledWith('a');
  });
});
