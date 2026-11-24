import { describe, expect, it } from 'vitest';
import { acpChatApi, whole, type AcpChatState } from './acpChat';
import type { Host } from './host/host';

describe('a far chat state that arrives with lists missing', () => {
  it('gets empty lists', () => {
    expect(whole({ phase: 'starting' } as unknown as AcpChatState)?.permissions).toEqual([]);
    expect(whole(null)).toBeNull();
  });
  it('is made whole on read and on every event', async () => {
    let push: (p: unknown) => void = () => undefined;
    const host = {
      live: true,
      invoke: async () => ({ phase: 'idle' }),
      listen: async (_e: string, cb: (p: unknown) => void) => ((push = cb), () => undefined),
    } as unknown as Host;
    const api = acpChatApi(host);
    expect((await api.state('p'))?.permissions).toEqual([]);
    const seen: unknown[] = [];
    await api.watch((_id, s) => seen.push(s.permissions));
    push({ paneId: 'p', state: { phase: 'working' } });
    expect(seen).toEqual([[]]);
  });
});
