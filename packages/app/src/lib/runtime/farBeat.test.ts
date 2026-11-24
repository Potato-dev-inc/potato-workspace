import { describe, expect, it } from 'vitest';
import { awayStatus, beatTargets, FAR_BEAT_MS, FAR_QUIET_MS, quietNodes } from './farBeat';

describe('far PC quiet', () => {
  const busy = new Set(['a', 'b']);
  it('is quiet only after the limit, and only for a PC with a busy chat', () => {
    const last = new Map([['a', 1000], ['b', 1000], ['c', 0]]);
    expect([...quietNodes(busy, last, 1000 + FAR_QUIET_MS)]).toEqual([]);
    expect([...quietNodes(busy, last, 1001 + FAR_QUIET_MS)].sort()).toEqual(['a', 'b']);
  });
  it('resumes by itself on the next reply', () => {
    const last = new Map([['a', 1000]]);
    expect(quietNodes(new Set(['a']), last, 40_000).has('a')).toBe(true);
    last.set('a', 39_000);
    expect(quietNodes(new Set(['a']), last, 40_000).has('a')).toBe(false);
  });
  it('a PC never heard from has no baseline, so it is not called quiet', () => {
    expect(quietNodes(busy, new Map(), 99_999).size).toBe(0);
  });
  it('shows Away instead of Working or waiting', () => {
    expect(awayStatus('running', true)).toBe('away');
    expect(awayStatus('waiting_input', true)).toBe('away');
    expect(awayStatus('idle', true)).toBe('idle');
    expect(awayStatus('running', false)).toBe('running');
  });
});

describe('who is asked the small question', () => {
  it('only a PC with a busy chat: an open, idle PC costs nothing (its level is read every 15 s by itself)', () => {
    const rows = { a: [{ status: 'idle' }, { status: 'exited' }], b: [{ status: 'running' }], c: [{ status: 'running', ended: true }] };
    expect(beatTargets(['a', 'b', 'c'], rows)).toEqual(['b']);
    // 30 s of an idle far chat open: no beat at all; one busy PC is asked every FAR_BEAT_MS.
    expect(Math.floor(30_000 / FAR_BEAT_MS)).toBe(6);
  });
});
