import { describe, expect, it } from 'vitest';
import { canRemember, isRisky, parseVerdict, toneOf } from './decisionCard';

describe('decision card rules', () => {
  it('only plain kinds can be remembered; delete and move are risky; unknown is neither', () => {
    for (const k of ['read', 'edit', 'execute', 'search', 'fetch']) expect(canRemember(k)).toBe(true);
    for (const k of ['delete', 'move', 'other', '', null, undefined, 'new_thing']) expect(canRemember(k as string | null)).toBe(false);
    expect(isRisky('delete') && isRisky('move')).toBe(true);
    expect(isRisky('execute') || isRisky(null)).toBe(false);
  });

  it('reads the meaning of a button from the agent option kind', () => {
    expect(toneOf('allow_once')).toBe('allow');
    expect(toneOf('allow_always')).toBe('allow');
    expect(toneOf('reject_once')).toBe('deny');
    expect(toneOf('plan_b')).toBe('other');
    expect(toneOf(undefined)).toBe('other');
  });

  it('reads the lines the chat keeps', () => {
    expect(parseVerdict('Allowed · Write notes.txt')).toMatchObject({ tone: 'allow', title: 'Write notes.txt', auto: false });
    expect(parseVerdict('Denied · rm -rf x · y')).toMatchObject({ tone: 'deny', title: 'rm -rf x · y' });
    expect(parseVerdict("Allowed automatically (you said don't ask again) · ls")).toMatchObject({ tone: 'allow', head: 'Allowed automatically', title: 'ls', auto: true });
    expect(parseVerdict('Waiting for your answer: Write a')).toMatchObject({ tone: 'wait', title: 'Write a' });
    expect(parseVerdict('Cancelled.')).toMatchObject({ tone: 'note', head: 'Cancelled.' });
    expect(parseVerdict('Answered: Plan B · ls').tone).toBe('note');
  });
});
