// @vitest-environment jsdom
// Screen level (phone): a message with no answer shows "No answer yet" with Try again and Start fresh, the header
// says "Waking up…" for a chat that is starting, and the strip under the chat says it too.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeClient } from '../../lib/bridge-types';
import { publishBridgeOutbox } from '../../lib/paneOutbox-bridge';
import type { OutboxMessage } from '../../lib/paneOutbox';
import { t } from '../../i18n';
import { useEnglish } from '../../i18n/test-utils';
import { phoneStatus } from '../../lib/phone-status';
import { PhoneChatView } from './PhoneChatView';
import { PhoneHeader } from './PhoneHeader';
import { AcpPhoneDock } from './AcpPhoneDock';

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

const stuck = (over: Partial<OutboxMessage> = {}): OutboxMessage => ({ id: 'm1', text: 'fix the login test', createdAt: 1, state: 'sent', waitingFor: null, error: null, noAnswer: true, ...over });

describe('phone: a message with no answer', () => {
  it('shows the line; Try again sends the same text; Start fresh stops the stuck turn', async () => {
    const sendPaneMessage = vi.fn(async (_p: string, text: string) => stuck({ id: 'm9', text, state: 'queued', noAnswer: false }));
    const acpCancel = vi.fn(async () => ({}));
    const bridge = {
      paneChat: vi.fn(async () => ({ available: true, reason: null, source: 'file', waitingFor: null, rev: 1, reset: false, items: [] })),
      sendPaneMessage,
      listPaneMessages: vi.fn(async () => [] as OutboxMessage[]),
      acpCancel,
    } as unknown as BridgeClient;
    await act(async () => {
      root.render(<PhoneChatView bridge={bridge} paneId="p1" canWatch canType />);
    });
    await act(async () => { publishBridgeOutbox('p1', [stuck()]); });
    expect(host.querySelector('[data-testid="chat-pending-no-answer"]')?.textContent).toBe('No answer yet');
    await act(async () => { (host.querySelector('[data-testid="chat-pending-retry"]') as HTMLButtonElement).click(); await Promise.resolve(); });
    expect(sendPaneMessage).toHaveBeenCalledWith('p1', 'fix the login test');
    await act(async () => { publishBridgeOutbox('p1', [stuck({ id: 'm2' })]); });
    await act(async () => { (host.querySelector('[data-testid="chat-pending-fresh"]') as HTMLButtonElement).click(); await Promise.resolve(); });
    expect(acpCancel).toHaveBeenCalledWith('p1');
  });
});

describe('phone: waking up', () => {
  it('the status line says Waking up… while the chat starts or resumes', () => {
    expect(phoneStatus(t, { state: 'working', now: 0, waking: true })).toMatchObject({ kind: 'waking', text: 'Waking up…', dot: 'working' });
    expect(phoneStatus(t, { state: 'idle', now: 0, waking: true }).text).toBe('Waking up…');
  });

  it('the header shows it', () => {
    act(() => root.render(<PhoneHeader title="Hi" status={phoneStatus(t, { state: 'idle', now: 0, waking: true })} agent={{ id: 'opencode', name: 'OpenCode' }} waiting={0} bridgeReady onMenu={() => undefined} onNew={() => undefined} />));
    expect(host.querySelector('.ph-head-state')?.textContent).toBe('Waking up…');
  });

  it('the strip under the chat shows it', async () => {
    const state = { phase: 'resuming', closed: false, turnInFlight: false, stopping: false, permissions: [] };
    const bridge = { acpSession: vi.fn(async () => state), listQuestions: vi.fn(async () => []) } as unknown as BridgeClient;
    await act(async () => {
      root.render(<AcpPhoneDock bridge={bridge} paneId="p1" canAnswer canType labels={new Map()} />);
    });
    await act(async () => { await Promise.resolve(); });
    expect(host.querySelector('[data-testid="acp-phone-strip"]')?.textContent).toContain('Waking up…');
  });
});
