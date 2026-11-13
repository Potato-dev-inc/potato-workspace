// @vitest-environment jsdom
// Two chat starts at once each have their own slot: ending one does not clear the other.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { addStart, removeStart, shownStart, useChatStarts } from './useChatStarts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('chat start slots (pure)', () => {
  it('keeps both starts and removes only the one named', () => {
    let l = addStart([], { id: 'a', agentId: 'codex', folder: 'C:\one' });
    l = addStart(l, { id: 'b', agentId: 'claude', folder: 'C:\two' });
    expect(shownStart(l)?.agentId).toBe('claude');
    l = removeStart(l, 'b');
    expect(shownStart(l)?.id).toBe('a');
    l = removeStart(l, 'a');
    expect(shownStart(l)).toBeNull();
  });
});

describe('useChatStarts with two concurrent starts', () => {
  it('ending the second leaves the first showing; ending the first clears it', () => {
    let api!: ReturnType<typeof useChatStarts>;
    function Probe() {
      api = useChatStarts();
      return null;
    }
    const host = document.createElement('div');
    const root = createRoot(host);
    act(() => root.render(<Probe />));
    let a = '';
    let b = '';
    act(() => {
      a = api.begin('codex', 'C:\one');
      b = api.begin('claude', 'C:\two');
    });
    expect(a).not.toBe(b);
    expect(api.count).toBe(2);
    expect(api.chatStarting?.agentId).toBe('claude');
    act(() => api.end(b));
    expect(api.chatStarting?.agentId).toBe('codex');
    act(() => api.end(a));
    expect(api.chatStarting).toBeNull();
    act(() => root.unmount());
  });
});
