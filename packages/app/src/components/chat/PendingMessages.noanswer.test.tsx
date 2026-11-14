// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLanguagePref } from '../../i18n';
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
  setLanguagePref('en', false);
});

const msg: OutboxMessage = { id: 'm1', text: 'run the tests', createdAt: 1, state: 'sent', waitingFor: null, error: null, noAnswer: true };
const render = (props: Partial<Parameters<typeof PendingMessages>[0]> = {}) =>
  act(() => root.render(<PendingMessages messages={[msg]} onCancel={async () => null} onHide={() => undefined} {...props} />));

describe('PendingMessages: no answer', () => {
  it('shows the line and both buttons', () => {
    render({ onRetry: async () => null, onStartFresh: () => undefined });
    expect(host.textContent).toContain('No answer yet');
    expect(host.querySelector('[data-testid="chat-pending-retry"]')?.textContent).toBe('Try again');
    expect(host.querySelector('[data-testid="chat-pending-fresh"]')?.textContent).toBe('Start fresh');
  });

  it('says it in Traditional Chinese', () => {
    setLanguagePref('zh-TW', false);
    render({ onRetry: async () => null, onStartFresh: () => undefined });
    expect(host.textContent).toContain('還沒有回應');
    expect(host.querySelector('[data-testid="chat-pending-retry"]')?.textContent).toBe('再試一次');
  });

  it('shows the reason when Try again is refused, and keeps the line', async () => {
    const onHide = vi.fn();
    render({ onRetry: async () => 'Too many waiting messages.', onHide });
    await act(async () => {
      (host.querySelector('[data-testid="chat-pending-retry"]') as HTMLButtonElement).click();
    });
    expect(host.querySelector('[data-testid="chat-pending-note"]')?.textContent).toBe('Too many waiting messages.');
    expect(onHide).not.toHaveBeenCalled();
  });
});
