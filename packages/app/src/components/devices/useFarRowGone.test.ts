import { describe, expect, it } from 'vitest';
import { farRowGone } from './useFarRowGone';

describe('farRowGone', () => {
  const base = { online: true, listed: true, seen: true, present: false };
  it('says gone only for a row that was listed, once the PC answered again and its list no longer has it', () => {
    expect(farRowGone(base)).toBe(true);
    expect(farRowGone({ ...base, online: false })).toBe(false); // only away: the last known row stays
    expect(farRowGone({ ...base, listed: false })).toBe(false); // back, but the list was not read yet
    expect(farRowGone({ ...base, seen: false })).toBe(false); // just started, never listed
    expect(farRowGone({ ...base, present: true })).toBe(false);
  });
});
