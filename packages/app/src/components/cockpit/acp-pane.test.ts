import { describe, expect, it } from 'vitest';
import type { TurnSummary } from '../../lib/cockpit-api';
import { acpResult } from './acp-pane';

const turn = (added: number, deleted: number): TurnSummary => ({ files: { count: 1, added, deleted, paths: ['a.txt'] } } as unknown as TurnSummary);

describe('the result strip files text', () => {
  it('counts lines for a real change', () => {
    expect(acpResult(turn(3, 1), null)?.files).toBe('1 file +3 −1');
  });
  it('says line endings only when no line changed (CRLF vs LF), never +N −N', () => {
    expect(acpResult(turn(0, 0), null)?.files).toBe('1 file · line endings only');
  });
});
