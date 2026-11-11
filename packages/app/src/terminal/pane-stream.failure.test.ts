import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaneStreamManager } from './pane-stream';

const enc = new TextEncoder();
const dec = new TextDecoder();

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('PaneStreamManager when the replay read fails', () => {
  it('tries again and then shows the replay', async () => {
    const manager = new PaneStreamManager();
    const got: string[] = [];
    const read = vi.fn().mockRejectedValueOnce(new Error('busy')).mockResolvedValue(Array.from(enc.encode('REPLAY')));
    manager.subscribe('p1', (chunk) => got.push(dec.decode(chunk)), read);
    await vi.advanceTimersByTimeAsync(300);
    expect(read).toHaveBeenCalledTimes(2);
    expect(got).toEqual(['REPLAY']);
    manager.ingest('p1', enc.encode('LIVE'));
    expect(got).toEqual(['REPLAY', 'LIVE']);
  });

  it('goes live from now when the read keeps failing, instead of buffering forever', async () => {
    const manager = new PaneStreamManager();
    const got: string[] = [];
    const read = vi.fn().mockRejectedValue(new Error('gone'));
    manager.subscribe('p1', (chunk) => got.push(dec.decode(chunk)), read);
    manager.ingest('p1', enc.encode('EARLY')); // buffered while loading
    await vi.advanceTimersByTimeAsync(5000);
    expect(read).toHaveBeenCalledTimes(3);
    manager.ingest('p1', enc.encode('LIVE'));
    expect(got).toEqual(['LIVE']);
  });

  it('stops retrying once the viewer has left', async () => {
    const manager = new PaneStreamManager();
    const read = vi.fn().mockRejectedValue(new Error('gone'));
    const unsubscribe = manager.subscribe('p1', () => undefined, read);
    await vi.advanceTimersByTimeAsync(10);
    unsubscribe();
    await vi.advanceTimersByTimeAsync(5000);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
