import { describe, expect, it } from 'vitest';
import type { Crew } from '../../lib/crews-api';
import type { TalkChange } from '../../lib/crew-talk-api';
import { changedEdges, roleName, ruleLines, sameState, touchedRoles } from './talkModel';

const crew: Crew = {
  name: 'C',
  roles: [
    { id: 'lead', name: 'Lead', agent_type: 'claude', task: 'x' },
    { id: 'easy', name: 'Easy', agent_type: 'claude', task: 'x', parent: 'lead' },
  ],
};
const changes: TalkChange[] = [
  { kind: 'handoff_added', from: 'easy', to: 'lead' },
  { kind: 'handoff_removed', from: 'lead', to: 'easy' },
  { kind: 'rule_added', role: 'easy', text: 'a' },
  { kind: 'rule_removed', role: 'easy', text: 'b' },
  { kind: 'rule_added', role: 'lead', text: 'c' },
];

describe('talkModel', () => {
  it('draws the added lines on "after" and the removed lines on "before"', () => {
    expect(changedEdges(changes, 'after')).toEqual(['easy>lead']);
    expect(changedEdges(changes, 'before')).toEqual(['lead>easy']);
  });
  it('lists each role whose rules change once', () => {
    expect(touchedRoles(changes)).toEqual(['easy', 'lead']);
  });
  it('compares rule lines, leaving blanks out', () => {
    expect(ruleLines('A -> a\n- one\n\n- two\n', 'A -> a\n- one\n- three\n')).toEqual({ added: ['- three'], removed: ['- two'] });
    expect(ruleLines('', '')).toEqual({ added: [], removed: [] });
  });
  it('names a role by its key, or gives the key back', () => {
    expect(roleName(crew, 'easy')).toBe('Easy');
    expect(roleName(crew, 'ghost')).toBe('ghost');
  });
  it('tells when the canvas is not as it was', () => {
    expect(sameState({ crew, rules: 'r' }, { crew: { ...crew }, rules: 'r' })).toBe(true);
    expect(sameState({ crew, rules: 'r' }, { crew, rules: 'r2' })).toBe(false);
  });
});
