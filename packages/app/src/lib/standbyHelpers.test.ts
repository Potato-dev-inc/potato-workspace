import { describe, expect, it } from 'vitest';
import { standbyForPane, standbysForProject, toBarStandbys, type StandbyHelperEntry } from './standbyHelpers';

const e = (over: Partial<StandbyHelperEntry>): StandbyHelperEntry => ({ id: 'a', name: 'Reviewer', agent: 'codex', model: 'gpt-5', project: 'C:/Work/App/', after_task: 'wait', state: 'ready', note: null, pane_id: null, home: null, used_by: null, taken_over: false, open_pane: null, person_pane: null, ...over });

describe('standby helpers for the top bar', () => {
  it('feeds the bar the standbys that are waiting, working or starting again, in the bar\'s own shape', () => {
    const out = toBarStandbys([e({}), e({ id: 'b', state: 'busy', pane_id: 'chat-1' }), e({ id: 'c', state: 'asleep' }), e({ id: 'd', state: 'problem' }), e({ id: 'f', state: 'starting' })]);
    expect(out).toEqual([
      { id: 'a', agent: 'codex', name: 'Reviewer', model: 'gpt-5', state: 'ready', project: 'C:/Work/App/' },
      { id: 'b', agent: 'codex', name: 'Reviewer', model: 'gpt-5', state: 'busy', project: 'C:/Work/App/' },
      { id: 'f', agent: 'codex', name: 'Reviewer', model: 'gpt-5', state: 'starting', project: 'C:/Work/App/' },
    ]);
  });

  it('matches a project in any spelling, and a busy standby to its chat', () => {
    expect(standbysForProject([e({})], 'c:/work/app')).toHaveLength(1);
    expect(standbysForProject([e({})], 'c:/work/other')).toHaveLength(0);
    expect(standbyForPane([e({ state: 'busy', pane_id: 'chat-1' })], 'chat-1')?.name).toBe('Reviewer');
    expect(standbyForPane([e({})], 'chat-1')).toBeUndefined();
  });
});
