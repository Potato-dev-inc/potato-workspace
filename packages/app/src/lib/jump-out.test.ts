import { describe, expect, it } from 'vitest';
import { JUMP_GRACE_MS, jumpOutLayout, pickJumpOut, type JumpInput } from './jump-out';
import type { Question } from './questions';
import type { FarQuestion } from './runtime/farQuestions';

const q = (id: string, extra: Partial<Question> = {}): Question => ({
  id, question: `Q ${id}`, choices: [{ id: 'a', label: 'A' }], allow_free_text: false, urgency: 'normal', created_at_ms: 100, expires_at_ms: 9e12, state: 'pending', ...extra,
});
const far = (id: string, extra: Partial<FarQuestion> = {}): FarQuestion => ({ key: `dev:n1:${id}`, node: 'n1', pcName: 'PC', id, question: 'far?', choices: [], allowFreeText: false, waitMs: 1000, seenAt: 50, ...extra });
const NOW = 100_000;

const needOf = (x: Question) => {
  const kind = x.consent ? 'consent' : x.kind === 'budget' ? 'budget' : x.limit ? 'limit' : 'question';
  return { id: `${kind}:${x.id}`, kind: kind as 'question', paneId: x.pane_id, since: x.created_at_ms };
};

/** Everything has been seen long ago: the grace is over. */
function input(over: Partial<JumpInput> & { qs?: Question[]; fars?: FarQuestion[] } = {}): JumpInput {
  const { qs = [], fars = [], ...rest } = over;
  const needs = [...qs.map(needOf), ...fars.map((f) => ({ id: `question:${f.key}`, kind: 'question' as const, since: f.seenAt }))];
  return {
    needs, questions: qs, far: fars, panes: [], promptIds: {}, view: 'pane', mode: 'orchestration', enabled: true, shown: [], farOpen: null,
    hidden: new Set(), isSnoozed: () => false, firstSeen: new Map(needs.map((n) => [n.id, 0])), now: NOW, ...rest,
  };
}

describe('pickJumpOut', () => {
  it('jumps out with a plain question, a helper-login card, a consent card, a budget card and a permission of a pane not on screen', () => {
    const rows: [string, Question][] = [
      ['plain', q('1')],
      ['helper login', q('2', { kind: 'helper_login' })],
      ['consent', q('3', { consent: { action: 'take_over', requester: 'x', target: 'y' } })],
      ['budget', q('4', { kind: 'budget' })],
      ['permission', q('5', { kind: 'acp_permission', pane_id: 'p9' })],
    ];
    for (const [name, card] of rows) expect(pickJumpOut(input({ qs: [card] })).entry?.key, name).toBe(card.id);
  });

  it('leaves limit, issue and CI cards in the Inbox', () => {
    const limit = q('1', { limit: { kind: 'usage_limit', agent_label: 'Claude' } });
    for (const card of [limit, q('2', { kind: 'issue_start' }), q('3', { kind: 'issue_push' }), q('4', { kind: 'ci_fix' }), q('5', { kind: 'ci_push' })]) {
      expect(pickJumpOut(input({ qs: [card] })).entry, card.id).toBeNull();
    }
  });

  it('draws a screen approval only while its prompt is up, and not when its pane (or the parent that shows its helper strip) is on screen', () => {
    const base = { needs: [{ id: 'approval:p1', kind: 'approval' as const, paneId: 'p1', since: 5 }], panes: [{ info: { id: 'p1', parent_pane_id: 'p0' }, status: 'waiting_input' }, { info: { id: 'p0' }, status: 'running' }] };
    expect(pickJumpOut(input({ ...base })).entry).toBeNull();
    const withPrompt = { ...base, promptIds: { p1: 'pr1' }, firstSeen: new Map([['approval:p1', 0]]) };
    expect(pickJumpOut(input(withPrompt)).entry?.key).toBe('approval:p1:pr1');
    expect(pickJumpOut(input({ ...withPrompt, shown: ['p1'] })).entry).toBeNull();
    expect(pickJumpOut(input({ ...withPrompt, shown: ['p0'] })).entry).toBeNull();
    expect(pickJumpOut(input({ ...withPrompt, shown: ['p7'] })).entry?.kind).toBe('approval');
    // A new prompt on the same pane is a new key.
    expect(pickJumpOut(input({ ...withPrompt, promptIds: { p1: 'pr2' } })).entry?.key).toBe('approval:p1:pr2');
  });

  it('hides a pane-permission question while its pane is shown, but not a helper login of that pane', () => {
    const perm = q('1', { kind: 'acp_permission', pane_id: 'p1' });
    const login = q('2', { kind: 'helper_login', pane_id: 'p1' });
    expect(pickJumpOut(input({ qs: [perm], shown: ['p1'] })).entry).toBeNull();
    expect(pickJumpOut(input({ qs: [login], shown: ['p1'] })).entry?.key).toBe('2');
  });

  it('each suppression: inbox view, individual mode, setting off', () => {
    const qs = [q('1')];
    expect(pickJumpOut(input({ qs, view: 'inbox' })).entry).toBeNull();
    expect(pickJumpOut(input({ qs, view: 'settings' })).entry).toBeNull();
    expect(pickJumpOut(input({ qs, mode: 'individual' })).entry).toBeNull();
    expect(pickJumpOut(input({ qs, enabled: false })).entry).toBeNull();
    expect(pickJumpOut(input({ qs })).entry?.key).toBe('1');
  });

  it('waits out a 3 s grace for a new item and says how long is left', () => {
    const base = input({ qs: [q('1')] });
    const fresh = { ...base, firstSeen: new Map([['question:1', NOW - 1000]]) };
    const pick = pickJumpOut(fresh);
    expect(pick.entry).toBeNull();
    expect(pick.waitMs).toBe(JUMP_GRACE_MS - 1000);
    expect(pickJumpOut({ ...fresh, now: NOW + JUMP_GRACE_MS }).entry?.key).toBe('1');
    // An id the caller has not recorded yet counts as just seen.
    expect(pickJumpOut({ ...base, firstSeen: new Map() }).waitMs).toBe(JUMP_GRACE_MS);
  });

  it('"Later" keeps an item hidden by its key; the key stays live so it is not pruned', () => {
    const pick = pickJumpOut(input({ qs: [q('1')], hidden: new Set(['1']) }));
    expect(pick.entry).toBeNull();
    expect(pick.liveKeys).toEqual(['1']);
    expect(pickJumpOut(input({ qs: [], hidden: new Set(['gone']) })).liveKeys).toEqual([]);
  });

  it('a snoozed item does not jump out', () => {
    expect(pickJumpOut(input({ qs: [q('1')], isSnoozed: (keys) => keys.includes('q-1') })).entry).toBeNull();
    expect(pickJumpOut(input({ fars: [far('f')], isSnoozed: (keys) => keys.includes('q-dev:n1:f') })).entry).toBeNull();
  });

  it('a far question jumps out under its dev key, unless its chat is open or it is not a plain question or permission', () => {
    expect(pickJumpOut(input({ fars: [far('f')] })).entry).toMatchObject({ key: 'dev:n1:f', kind: 'question' });
    expect(pickJumpOut(input({ fars: [far('f', { kind: 'acp_permission', paneId: 'fp' })] })).entry?.key).toBe('dev:n1:f');
    expect(pickJumpOut(input({ fars: [far('f', { paneId: 'fp' })], farOpen: { node: 'n1', paneId: 'fp' } })).entry).toBeNull();
    expect(pickJumpOut(input({ fars: [far('f', { paneId: 'fp' })], farOpen: { node: 'n1', paneId: 'other' } })).entry?.key).toBe('dev:n1:f');
    expect(pickJumpOut(input({ fars: [far('f', { kind: 'usage_limit' })] })).entry).toBeNull();
  });

  it('shows ONE card, the first in Inbox order (consent before a question, then oldest), and counts the rest', () => {
    const consent = q('c', { consent: { action: 'take_over', requester: 'x', target: 'y' }, created_at_ms: 900 });
    const old = q('old', { created_at_ms: 10 });
    const young = q('young', { created_at_ms: 20 });
    const pick = pickJumpOut(input({ qs: [young, old, consent] }));
    expect(pick.entry?.key).toBe('c');
    expect(pick.more).toBe(2);
    const pick2 = pickJumpOut(input({ qs: [young, old] }));
    expect(pick2.entry?.key).toBe('old');
    expect(pick2.more).toBe(1);
  });

  it('a question that is gone or no longer pending leaves no card', () => {
    const gone = input({ qs: [q('1')] });
    expect(pickJumpOut({ ...gone, questions: [] }).entry).toBeNull();
    expect(pickJumpOut({ ...gone, questions: [q('1', { state: 'answered' })] }).entry).toBeNull();
  });
});

describe('jumpOutLayout', () => {
  it('goes compact and stays inside a narrow column', () => {
    const l = jumpOutLayout(120, 400);
    expect(l.narrow).toBe(true);
    expect(l.tight).toBe(true);
    expect(l.width).toBeLessThanOrEqual(120);
  });
  it('is the full card in a wide column with room', () => {
    expect(jumpOutLayout(800, 400)).toEqual({ width: 440, narrow: false, tight: false, mini: false, gone: false });
  });
  it('never exceeds the column; icon row under 140, not drawn under 80', () => {
    expect(jumpOutLayout(97, 400)).toMatchObject({ width: 81, mini: true, gone: false });
    expect(jumpOutLayout(79, 400)).toMatchObject({ gone: true });
    for (const w of [60, 97, 139, 200, 299]) expect(jumpOutLayout(w, 400).width).toBeLessThanOrEqual(w);
  });
});
