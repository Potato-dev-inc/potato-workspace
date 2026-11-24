// Another PC's questions as cards here: untrusted text is cleaned and cut, ids are kept apart from this PC's own.
import { describe, expect, it } from 'vitest';
import { asQuestion, farQuestionsOf, FAR_CHOICE_MAX, FAR_QUESTION_MAX } from './farQuestions';

describe('far questions', () => {
  it('keys a card by the far PC and its id, so it can never be one of this PC\'s own cards', () => {
    const [q] = farQuestionsOf('abc', 'Work PC', [{ id: 'q1', question: 'Run it?', choices: [{ id: 'y', label: 'Yes' }] }], () => 5);
    expect(q).toMatchObject({ key: 'dev:abc:q1', id: 'q1', node: 'abc', pcName: 'Work PC', seenAt: 5, allowFreeText: false });
    expect(asQuestion(q!, 'On Work PC')).toMatchObject({ id: 'dev:abc:q1', context: 'On Work PC', created_at_ms: 5, state: 'pending' });
  });

  it('drops what is not a question, strips control and bidi characters, and cuts long text and long lists', () => {
    const raw = [
      null,
      'text',
      { id: '', question: 'no id' },
      { id: 'a', question: '' },
      { id: 'b', question: `${'x'.repeat(5000)}`, choices: Array.from({ length: 50 }, (_, i) => ({ id: `c${i}`, label: `L${i}‮\u0000` })) },
      { id: 'c', question: 'ok​go', choices: [{ id: '', label: 'empty id' }, { id: 'k', label: 'k'.repeat(500) }, 7] },
    ];
    const out = farQuestionsOf('n', 'PC', raw);
    expect(out.map((q) => q.id)).toEqual(['b', 'c']);
    expect(out[0]!.question).toHaveLength(600);
    expect(out[0]!.choices).toHaveLength(FAR_CHOICE_MAX);
    expect(out[0]!.choices[0]!.label).toBe('L0');
    expect(out[1]!.question).toBe('okgo');
    expect(out[1]!.choices).toEqual([{ id: 'k', label: 'k'.repeat(80) }]);
  });

  it('keeps at most FAR_QUESTION_MAX, reads the wait as a length of time (never a date), and survives a non-list answer', () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ id: `q${i}`, question: `Q${i}`, created_at_ms: 1_000, expires_at_ms: 1_000 + 90_000 }));
    const out = farQuestionsOf('n', 'PC', many);
    expect(out).toHaveLength(FAR_QUESTION_MAX);
    expect(out[0]!.waitMs).toBe(90_000);
    expect(farQuestionsOf('n', 'PC', [{ id: 'z', question: 'Z', created_at_ms: 9e15, expires_at_ms: 1 }])[0]!.waitMs).toBe(10 * 60_000);
    expect(farQuestionsOf('n', 'PC', { questions: [] })).toEqual([]);
    expect(farQuestionsOf('n', 'PC', undefined)).toEqual([]);
  });
});

describe('far questions: why Force yes left a card to the person', () => {
  it('carries the far PC\'s reason code into the card, where the card reads it, and drops anything that is not a plain code', async () => {
    const { forceYesLeft } = await import('../decisionCard');
    const row = { id: 'q1', question: 'Run it?', kind: 'acp_permission', choices: [{ id: 'y', label: 'Yes' }] };
    const [q, bad] = farQuestionsOf('abc', 'Work PC', [{ ...row, force_yes_left: 'risky' }, { ...row, id: 'q2', force_yes_left: '<b>x</b>' }], () => 5);
    expect(forceYesLeft(asQuestion(q!, 'On Work PC'))).toBe('risky');
    expect(asQuestion(q!, 'On Work PC').context).toContain('On Work PC');
    expect(forceYesLeft(asQuestion(bad!, 'On Work PC'))).toBeNull();
  });
});
