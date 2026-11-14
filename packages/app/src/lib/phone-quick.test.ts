import { describe, expect, it } from 'vitest';
import { asksSomething, quickRepliesFor } from './phone-quick';

describe('quick replies only when a chip can answer', () => {
  it('gives chips for a yes or no question', () => {
    expect(quickRepliesFor('I changed the file. Want me to run the tests?')).toEqual(['yes', 'no', 'runTests']);
  });
  it('gives none for an open question or no question', () => {
    expect(asksSomething('Hi! What can I help you with today?')).toBe(false);
    expect(quickRepliesFor('Hi! What can I help you with today?')).toEqual([]);
    expect(quickRepliesFor('Done. The file is saved.')).toEqual([]);
    expect(quickRepliesFor(null)).toEqual([]);
  });
});
