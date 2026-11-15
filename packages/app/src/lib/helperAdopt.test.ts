import { describe, expect, it } from 'vitest';
import { adoptRefusal, adoptTargets, type AdoptPane } from './helperAdopt';

const pane = (id: string, parent: string | null = null, project = 'a'): AdoptPane => ({ id, parent, project });
const all = [pane('a'), pane('b', 'a'), pane('c', 'b'), pane('d'), pane('e', null, 'other')];
const get = (id: string) => all.find((p) => p.id === id);

describe('adoptRefusal', () => {
  it('allows a main agent onto another main agent of the same project', () => {
    expect(adoptRefusal(get('d'), get('a'), all)).toBeNull();
  });
  it('refuses itself, a missing agent, another project', () => {
    expect(adoptRefusal(get('a'), get('a'), all)).toBe('adopt.self');
    expect(adoptRefusal(get('a'), undefined, all)).toBe('adopt.gone');
    expect(adoptRefusal(get('d'), get('e'), all)).toBe('adopt.noProject');
  });
  it('refuses a loop however deep the target sits under the dragged agent', () => {
    expect(adoptRefusal(get('a'), get('b'), all)).toBe('adopt.loop');
    expect(adoptRefusal(get('a'), get('c'), all)).toBe('adopt.loop');
  });
  it('refuses a helper being moved, and a helper being the target', () => {
    expect(adoptRefusal(get('b'), get('d'), all)).toBe('adopt.isHelper');
    expect(adoptRefusal(get('d'), get('b'), all)).toBe('adopt.targetHelper');
  });
  it('does not hang on a broken table', () => {
    const loop = [pane('x', 'y'), pane('y', 'x'), pane('z')];
    expect(adoptRefusal(loop[2], loop[0], loop)).toBe('adopt.targetHelper');
  });
});

describe('adoptTargets', () => {
  it('lists the main agents of the same project, not itself, its helpers or other projects', () => {
    expect(adoptTargets(get('d'), all).map((p) => p.id)).toEqual(['a']);
    expect(adoptTargets(get('a'), all).map((p) => p.id)).toEqual(['d']);
  });
  it('a helper has no targets (it can only be made a main agent again)', () => {
    expect(adoptTargets(get('b'), all)).toEqual([]);
  });
});
