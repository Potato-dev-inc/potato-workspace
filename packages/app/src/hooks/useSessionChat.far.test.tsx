// @vitest-environment jsdom
// A far chat whose PC goes off keeps the transcript it had (the host is a new object then, and the reopen fails): it did go empty
// ("Waiting for the agent's session file…") before, and it comes back by itself when the PC answers.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Host } from '../lib/host/host';
import { ALL_CAPS } from '../lib/host/host';
import { chatTuning } from './chatTuning';
import { useSessionChat, type SessionChatHook } from './useSessionChat';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const farHost = (invoke: Host['invoke']): Host => ({ place: { kind: 'pc', node: 'n1', name: 'Box' }, live: true, caps: ALL_CAPS, invoke, listen: async () => () => undefined });
const SNAPSHOT = { available: true, reason: null, source: 'acp', items: [{ kind: 'assistant', id: 'a1', at: null, text: 'hello from far', model: null, finalAnswer: true }] };

let root: Root | null = null;
afterEach(() => act(() => root?.unmount()));
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

describe('useSessionChat of a far chat', () => {
  it('keeps the transcript when the PC stops answering, and after the chat is closed and opened again', async () => {
    let latest!: SessionChatHook;
    const Probe = ({ host }: { host: Host }) => ((latest = useSessionChat('far-pane-1', true, host)), null);
    root = createRoot(document.createElement('div'));
    await act(async () => root!.render(<Probe host={farHost(vi.fn(async () => SNAPSHOT) as never)} />));
    await flush();
    expect(latest.state).toBe('ready');
    expect(latest.turns.length).toBeGreaterThan(0);
    // The PC goes off: a new host object, and every call fails.
    const off = farHost(vi.fn(async () => Promise.reject(new Error('offline'))) as never);
    await act(async () => root!.render(<Probe host={off} />));
    await flush();
    expect(latest.state).toBe('ready');
    expect(latest.turns.length).toBeGreaterThan(0);
    // Closed and opened again while still off: the last transcript is there at once.
    await act(async () => root!.render(<></>));
    await act(async () => root!.render(<Probe host={off} />));
    expect(latest.turns.length).toBeGreaterThan(0);
  });

  it('opens the feed once when the host is made again with the same link (the far level arrived)', async () => {
    const invoke = vi.fn(async () => SNAPSHOT);
    chatTuning.graceMs = 2000;
    const link = {};
    let latest!: SessionChatHook;
    const Probe = ({ host }: { host: Host }) => ((latest = useSessionChat('far-pane-2', true, host)), null);
    root = createRoot(document.createElement('div'));
    await act(async () => root!.render(<Probe host={{ ...farHost(invoke as never), caps: { ...ALL_CAPS, message: false }, link }} />));
    await act(async () => root!.render(<Probe host={{ ...farHost(invoke as never), link }} />));
    await flush();
    expect(latest.state).toBe('ready');
    chatTuning.graceMs = 0;
    expect(invoke.mock.calls.filter((call) => (call as unknown[])[0] === 'session_chat_open')).toHaveLength(1);
  });
});
