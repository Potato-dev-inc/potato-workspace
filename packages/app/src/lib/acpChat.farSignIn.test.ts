// P2.2: the chat's sign-in card drives the far PC's own sign-in (same commands, same args, through the host).
import { describe, expect, it } from 'vitest';
import { acpChatApi } from './acpChat';
import { WATCH_CAPS, type Host } from './host/host';

describe('acpChatApi(far host) sign-in', () => {
  it('start, status, stop and retry go to the far PC as the same commands', async () => {
    const calls: [string, unknown][] = [];
    const host: Host = {
      place: { kind: 'pc', node: 'aa', name: 'Linux box' },
      live: true,
      caps: WATCH_CAPS,
      listen: async () => () => undefined,
      invoke: async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
        calls.push([cmd, args]);
        return (cmd === 'chat_signin_start' ? { pane_id: 'hidden' } : cmd === 'chat_signin_status' ? { alive: true, asking: false, pane_id: 'hidden' } : undefined) as T;
      },
    };
    const api = acpChatApi(host);
    const signIn = api.signIn!('p1');
    expect(await signIn.start()).toBe('hidden');
    expect((await signIn.status()).alive).toBe(true);
    await signIn.stop();
    await api.retrySignIn!('p1');
    expect(calls).toEqual([
      ['chat_signin_start', { pane_id: 'p1' }],
      ['chat_signin_status', { pane_id: 'p1' }],
      ['chat_signin_stop', { pane_id: 'p1' }],
      ['acp_chat_retry_sign_in', { paneId: 'p1' }],
    ]);
  });
});
