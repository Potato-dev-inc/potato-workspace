import { describe, expect, it } from 'vitest';
import type { Crew } from '../../lib/crews-api';
import { addRole, clampZoom, edges, extent, fitZoom, layout, leadOf, moveRole, pathFor, removeRole, renameRole, rightsKeys, setPermissions, standbyTotal, toggleHandoff, BOX_W, MAX_ROLES } from './model';

const crew = (): Crew => ({
  name: 'Test crew',
  roles: [
    { id: 'lead', name: 'Lead', agent_type: 'claude', task: 'lead', hands_to: ['easy', 'checker'] },
    { id: 'easy', name: 'Easy worker', agent_type: 'claude', task: 'easy', parent: 'lead', standbys: 2 },
    { name: 'Checker', agent_type: 'claude', task: 'check', parent: 'lead', check: true, hands_to: ['lead'], standbys: 1 },
  ],
});

describe('the crew canvas model', () => {
  it('lays the lead above its helpers and keeps a saved position', () => {
    const c = crew();
    c.roles[1] = { ...c.roles[1], position: { x: 500, y: 300 } };
    const spots = layout(c);
    expect(spots.get('lead')!.y).toBeLessThan(spots.get('Checker')!.y);
    expect(spots.get('easy')).toEqual({ x: 500, y: 300 });
    expect(extent(spots).width).toBeGreaterThanOrEqual(500 + BOX_W);
  });

  it('draws a hand-off once, a checker handing back as the one loop, and a plain report line when nothing is handed on', () => {
    const lines = edges(crew());
    expect(lines.filter((l) => l.from === 'lead' && l.to === 'easy')).toHaveLength(1);
    expect(lines.find((l) => l.from === 'Checker' && l.to === 'lead')?.kind).toBe('back');
    const plain = crew();
    plain.roles[0] = { ...plain.roles[0], hands_to: [] };
    expect(edges(plain).find((l) => l.from === 'lead' && l.to === 'easy')?.kind).toBe('team');
  });

  it('names the way a task goes: the lead, the chosen role, then each checker', () => {
    expect(pathFor(crew(), 'easy')).toEqual(['lead', 'easy', 'Checker']);
    expect(pathFor(crew(), 'Checker')).toEqual(['lead', 'Checker']);
  });

  it('renames a role and the roles that point at it follow (a role with an id keeps its id)', () => {
    const c = crew();
    const byName = renameRole(c, 2, 'Reviewer');
    expect(byName.roles[2].name).toBe('Reviewer');
    expect(byName.roles[0].hands_to).toEqual(['easy', 'Reviewer']);
    const byId = renameRole(c, 1, 'Quick worker');
    expect(byId.roles[1].name).toBe('Quick worker');
    expect(byId.roles[2].parent).toBe('lead');
    expect(byId.roles[0].hands_to).toEqual(['easy', 'checker']);
  });

  it('adds a helper with a free name under a role, and stops at the most a crew holds', () => {
    let c = crew();
    c = addRole(c, 'lead', 'codex', 'job');
    expect(c.roles[3]).toMatchObject({ name: 'Helper 1', agent_type: 'codex', parent: 'lead' });
    c = addRole(c, 'lead', 'codex', 'job');
    expect(c.roles[4].name).toBe('Helper 2');
    while (c.roles.length < MAX_ROLES) c = addRole(c, 'lead', 'codex', 'job');
    expect(addRole(c, 'lead', 'codex', 'job').roles).toHaveLength(MAX_ROLES);
  });

  it('takes a helper out: the roles under it move up, hand-offs to it go, and the lead stays', () => {
    const c = removeRole(crew(), 'easy');
    expect(c.roles.map((r) => r.name)).toEqual(['Lead', 'Checker']);
    expect(c.roles[0].hands_to).toEqual(['checker']);
    expect(removeRole(crew(), 'lead').roles).toHaveLength(3);
  });

  it('toggles a hand-off, moves a box, changes a right, and counts the helpers kept ready', () => {
    const c = toggleHandoff(crew(), 'easy', 'Checker');
    expect(c.roles[1].hands_to).toEqual(['Checker']);
    expect(toggleHandoff(c, 'easy', 'Checker').roles[1].hands_to).toEqual([]);
    expect(moveRole(crew(), 'easy', { x: 10.6, y: -5 }).roles[1].position).toEqual({ x: 11, y: 0 });
    expect(setPermissions(crew(), 0, { write: 'worktree' }).roles[0].permissions).toMatchObject({ read: true, write: 'worktree', run: 'none' });
    expect(standbyTotal(crew())).toBe(3);
    expect(leadOf(crew())?.name).toBe('Lead');
  });

  it('says a role rights in message keys, so both languages read them', () => {
    expect(rightsKeys(undefined)).toEqual(['read', 'write.none', 'run.none']);
    expect(rightsKeys({ read: true, write: 'scoped', run: 'ask', start_helpers: true, merge: true })).toEqual(['read', 'write.scoped', 'run.ask', 'helpers', 'merge']);
  });
});

describe('layout that fits a normal window, and zoom', () => {
  it('wraps a long row to the next one, so no row holds more than four boxes', () => {
    const c: Crew = { name: 'Big', roles: [{ id: 'lead', name: 'Lead', agent_type: 'claude', task: 't' }] };
    for (let i = 1; i <= 6; i++) c.roles.push({ id: `h${i}`, name: `H${i}`, agent_type: 'claude', task: 't', parent: 'lead' });
    const spots = [...layout(c).values()];
    const ys = [...new Set(spots.map((s) => s.y))].sort((a, b) => a - b);
    expect(ys).toHaveLength(3);
    expect(spots.filter((s) => s.y === ys[1])).toHaveLength(4);
    expect(spots.filter((s) => s.y === ys[2])).toHaveLength(2);
    expect(extent(layout(c)).width).toBeLessThan(1000);
  });

  it('fits the whole surface into the room, never blows a small crew up, and clamps the zoom', () => {
    expect(fitZoom({ width: 2000, height: 500 }, { width: 1000, height: 800 })).toBe(0.5);
    expect(fitZoom({ width: 400, height: 300 }, { width: 1000, height: 800 })).toBe(1);
    expect(fitZoom({ width: 400, height: 300 }, { width: 0, height: 0 })).toBe(1);
    expect(clampZoom(0.1)).toBe(0.4);
    expect(clampZoom(9)).toBe(1.6);
  });
});
