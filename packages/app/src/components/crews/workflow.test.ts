import { describe, expect, it } from 'vitest';
import type { Crew } from '../../lib/crews-api';
import { afterAddInWorkflow, addRole, frontOf, isWorkflow, kindOf, setFront, setHelperCap, setStartMode } from './model';

const plain = (): Crew => ({
  name: 'Crew',
  roles: [
    { name: 'Lead', agent_type: 'claude', task: 'Lead.' },
    { name: 'A', agent_type: 'claude', task: 'A.', parent: 'Lead' },
    { name: 'B', agent_type: 'claude', task: 'B.', parent: 'A' },
  ],
});

describe('workflow edits', () => {
  it('an older crew is not a workflow', () => {
    expect(isWorkflow(plain())).toBe(false);
    expect(frontOf(plain())).toBeUndefined();
    expect(kindOf(plain().roles[1])).toBe('minion');
  });

  it('marking the Front puts every helper under it and gives each a "when to use"', () => {
    const w = setFront(plain(), true, 'tasks that fit');
    expect(frontOf(w)?.name).toBe('Lead');
    expect(w.roles.map((r) => r.parent ?? null)).toEqual([null, 'Lead', 'Lead']);
    expect(w.roles.slice(1).map((r) => r.when_to_use)).toEqual(['tasks that fit', 'tasks that fit']);
  });

  it('turning it off makes the crew plain again', () => {
    const w = setStartMode(setHelperCap(setFront(plain(), true, 'x'), 5), 'horde');
    expect(w.start_mode).toBe('horde');
    expect(w.helper_cap).toBe(5);
    const back = setFront({ ...w, how_i_work: 'note' }, false);
    expect(isWorkflow(back)).toBe(false);
    expect(back).toMatchObject({ how_i_work: null, start_mode: null, helper_cap: null });
    expect(back.roles.every((r) => !r.front && !r.kind && !r.when_to_use)).toBe(true);
  });

  it('the cap stays between 1 and 10, and the default of 3 is not written', () => {
    expect(setHelperCap(plain(), 3).helper_cap).toBeNull();
    expect(setHelperCap(plain(), 99).helper_cap).toBe(10);
    expect(setHelperCap(plain(), 0).helper_cap).toBeNull();
    expect(setStartMode(plain(), 'front').start_mode).toBeNull();
  });

  it('a helper added to a workflow reports to the Front', () => {
    const w = setFront(plain(), true, 'x');
    const next = afterAddInWorkflow(w, addRole(w, 'A', 'claude', 'job'), 'when');
    expect(next.roles[3]).toMatchObject({ parent: 'Lead', when_to_use: 'when' });
    const old = plain();
    expect(afterAddInWorkflow(old, addRole(old, 'A', 'claude', 'job'), 'when').roles[3].parent).toBe('A');
  });
});
