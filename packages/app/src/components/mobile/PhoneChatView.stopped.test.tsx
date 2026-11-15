// @vitest-environment jsdom
// Screen level (phone): a message the PC's outbox could not send shows "Sending stopped" with Try again.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeClient } from '../../lib/bridge-types';
import { publishBridgeOutbox } from '../../lib/paneOutbox-bridge';
import type { OutboxMessage } from '../../lib/paneOutbox';
import { useEnglish } from '../../i18n/test-utils';
import { PhoneChatView } from './PhoneChatView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
useEnglish();

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const stopped = (over: Partial<OutboxMessage> = {}): OutboxMessage => ({ id: 'm1', text: 'fix the login test', createdAt: 1, state: 'failed', waitingFor: null, error: 'Sending stopped. Try again.', noAnswer: false, ...over });

describe('phone: sending stopped', () => {
  it('shows the line; Try again sends the same text again', async () => {
    const sendPaneMessage = vi.fn(async (_p: string, text: string) => stopped({ id: 'm9', text, state: 'queued', error: null }));
    const bridge = {
      paneChat: vi.fn(async () => ({ available: true, reason: null, source: 'file', waitingFor: null, rev: 1, reset: false, items: [] })),
      sendPaneMessage,
      listPaneMessages: vi.fn(async () => [] as OutboxMessage[]),
    } as unknown as BridgeClient;
    await act(async () => {
      root.render(<PhoneChatView bridge={bridge} paneId="p1" canWatch canType />);
    });
    await act(async () => { publishBridgeOutbox('p1', [stopped()]); });
    expect(host.querySelector('[data-testid="chat-pending-error"]')?.textContent).toBe('Sending stopped');
    await act(async () => { (host.querySelector('[data-testid="chat-pending-try-again"]') as HTMLButtonElement).click(); await Promise.resolve(); });
    expect(sendPaneMessage).toHaveBeenCalledWith('p1', 'fix the login test');
  });
});
