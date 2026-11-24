import { afterEach, describe, expect, it } from 'vitest';
import { useChinese, useEnglish } from '../i18n/test-utils';
import { waitCaption } from './questions';
import type { Question } from './questions';
import { canRemember, decisionOptions, forceYesLeft, isRisky, optionWords, parseVerdict, toneOf } from './decisionCard';

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

  it('reads why Force yes left a question to the person from the card context', () => {
    const q = (context?: string) => ({ context }) as Question;
    expect(forceYesLeft(q('Kind of action: execute\nThe agent waits.\nForce yes asked: risky'))).toBe('risky');
    expect(forceYesLeft(q('Kind of action: execute'))).toBeNull();
    expect(forceYesLeft(q())).toBeNull();
  });
});

describe('option words in another language', () => {
  afterEach(() => useEnglish());
  const q = { id: 'q', question: 'Claude asks permission: Write a.txt', choices: [{ id: 'a', label: 'Yes' }, { id: 'b', label: 'Yes, allow all edits during this session' }, { id: 'c', label: 'No' }, { id: 'd', label: 'Always allow `git status`' }], allow_free_text: false, urgency: 'normal', created_at_ms: 0, expires_at_ms: 1, state: 'pending' } as never;
  const perm = { questionId: 'q', options: [{ id: 'a', kind: 'allow_once' }, { id: 'b', kind: 'allow_always' }, { id: 'c', kind: 'reject_once' }, { id: 'd', kind: 'allow_always' }] } as never;
  it('keeps the agent names in English', () => {
    useEnglish();
    expect(decisionOptions(q, perm).map((o) => o.label)).toEqual(['Yes', 'Yes, allow all edits during this session', 'No', 'Always allow `git status`']);
  });
  it('shows the app’s own translated labels in Chinese, but not over a label that names a command', () => {
    useChinese();
    expect(decisionOptions(q, perm).map((o) => o.label)).toEqual(['允許一次', '這個 AI 助理都允許', '拒絕', 'Always allow `git status`']);
  });
});

describe('option words when only an option id (a far chat) is known', () => {
  afterEach(() => useEnglish());
  it('translates by the id or the usual English label, never a command label', () => {
    useChinese();
    expect(optionWords('allow', 'Yes')).toBe('允許一次');
    expect(optionWords('opt-2', 'Yes, allow all edits during this session')).toBe('這個 AI 助理都允許');
    expect(optionWords('opt-3', 'No')).toBe('拒絕');
    expect(optionWords('proceed_always', 'x')).toBe('這個 AI 助理都允許');
    expect(optionWords('x', 'Always allow `git status`')).toBe('Always allow `git status`');
    expect(optionWords('x', 'Something else')).toBe('Something else');
  });

  it('keeps the three far options apart whatever the id looks like', () => {
    useChinese();
    const rows = [
      [['allow', 'Yes'], ['allow_session', 'Yes, allow all edits during this session'], ['reject', 'No, and tell the agent what to do']],
      [['allow_once', 'Allow'], ['allow_always', 'Always allow'], ['reject_once', 'Reject']],
      [['approved', 'Yes'], ['approved-for-session', 'Yes, allow all edits during this session'], ['abort', 'No']],
    ];
    for (const row of rows) expect(row.map(([id, name]) => optionWords(id, name))).toEqual(['允許一次', '這個 AI 助理都允許', '拒絕']);
  });
});

describe('the wait caption in Chinese', () => {
  afterEach(() => useEnglish());
  const base = { id: 'q', question: 'x', choices: [], allow_free_text: false, urgency: 'normal', created_at_ms: 0, expires_at_ms: 24 * 3_600_000, state: 'pending' } as never;
  it('has no space after a Chinese name, a space before the number, and a space after a Latin name', () => {
    useChinese();
    expect(waitCaption(base, 0)).toBe('AI 助理會在 24 小時後停止等待');
    expect(waitCaption({ ...(base as object), agent: 'Claude' } as never, 0)).toBe('Claude 會在 24 小時後停止等待');
  });
});
