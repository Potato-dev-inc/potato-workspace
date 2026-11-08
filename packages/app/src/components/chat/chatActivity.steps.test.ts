import { describe, expect, it } from 'vitest';
import type { ToolStep } from '../../lib/sessionChatModel';
import { doneSummary, stepElapsedMs, stepLabel } from './chatActivity';

function tool(id: string, name: string, extra: Partial<ToolStep['call']> = {}): ToolStep {
  const call = { kind: 'toolCall' as const, id, at: null, callId: id, name, summary: `${name} target`, ...extra };
  return { kind: 'tool', id, call, result: null, status: 'ok' };
}

describe('the live step list words', () => {
  const timed = (id: string, start: string | null, end: string | null): ToolStep => ({
    ...tool(id, 'Edit', { at: start, summary: 'src/a.ts' }),
    result: end ? { kind: 'toolResult' as const, id: `r${id}`, at: end, callId: id, ok: true, output: '' } : null,
  });

  it('labels a step with its name and summary, and times it from its two stamps', () => {
    const step = timed('1', '2026-10-28T01:00:00Z', '2026-10-28T01:00:03Z');
    expect(stepLabel(step)).toBe('Edit src/a.ts');
    expect(stepElapsedMs(step)).toBe(3000);
    expect(stepElapsedMs(timed('2', null, '2026-10-28T01:00:03Z'))).toBeNull();
    expect(stepElapsedMs(timed('3', '2026-10-28T01:00:00Z', null))).toBeNull();
  });

  it('folds a finished turn to "Done in 14s · 2 steps", and drops the time when no row has one', () => {
    const steps = [timed('1', '2026-10-28T01:00:00Z', '2026-10-28T01:00:05Z'), timed('2', '2026-10-28T01:00:06Z', '2026-10-28T01:00:14Z')];
    expect(doneSummary(steps)).toBe('Done in 14s · 2 steps');
    expect(doneSummary([tool('1', 'Read')])).toBe('Done · 1 step');
  });
});
