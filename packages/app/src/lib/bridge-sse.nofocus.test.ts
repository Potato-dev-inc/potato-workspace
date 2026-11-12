import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BridgeEvent } from './bridge-types';
import { subscribeBridgeEventsHandle } from './bridge-sse';

class MockEventSource {
  static instances: MockEventSource[] = [];
  listeners = new Map<string, (ev: { data: string }) => void>();
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  constructor(public url: string) {
    MockEventSource.instances.push(this);
  }
  addEventListener(name: string, cb: (ev: { data: string }) => void) {
    this.listeners.set(name, cb);
  }
  emit(name: string, data: string) {
    this.listeners.get(name)?.({ data });
  }
  close() {}
}

const BASE = 'http://127.0.0.1:1234';

describe('bridge SSE after Focus was cut', () => {
  afterEach(() => {
    MockEventSource.instances = [];
    vi.unstubAllGlobals();
  });

  it('does not listen for a focus event, and an old PC sending one changes nothing', () => {
    vi.stubGlobal('EventSource', MockEventSource);
    const events: BridgeEvent[] = [];
    const handle = subscribeBridgeEventsHandle(BASE, (e) => events.push(e));
    expect(MockEventSource.instances[0].listeners.has('focus')).toBe(false);
    MockEventSource.instances[0].emit('focus', JSON.stringify({ on: true }));
    expect(events).toEqual([]);
    handle.unsubscribe();
  });
});
