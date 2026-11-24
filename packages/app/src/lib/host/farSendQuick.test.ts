import { afterEach, describe, expect, it, vi } from 'vitest';
import { useEnglish } from '../../i18n/test-utils';
import { farHost, SEND_PATIENCE_MS } from './far';
import type { PcLinkClient } from '../runtime/pclink';

useEnglish();

describe('a message to a far PC that does not answer', () => {
  afterEach(() => vi.useRealTimers());
  it('is refused with one plain line after a few seconds (the box keeps the text)', async () => {
    vi.useFakeTimers();
    const client = { node: 'n1', call: () => new Promise(() => undefined), me: async () => ({}) } as unknown as PcLinkClient;
    const host = farHost(client, {} as never, { name: 'pm-sandbox' });
    const sent = host.invoke('pane_message_send', { paneId: 'dev:n1:c1', text: 'hi' });
    const seen = sent.catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(SEND_PATIENCE_MS + 1);
    expect(await seen).toBe("pm-sandbox isn't answering. Your message is kept here.");
  });
});
