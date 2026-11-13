import { describe, expect, it } from 'vitest';
import type { AttentionItem, AttentionSnapshot } from '../../lib/attention';
import { QUIET_OFF } from '../../lib/notify-levels';
import { finishedRun, needsFromSnapshot, petIsQuiet, plainAgentName } from './petSources';

const item = (over: Partial<AttentionItem>): AttentionItem =>
  ({
    id: 'i1',
    key: 'approval:p1',
    kind: 'approval',
    lane: 'blocking',
    rank: 1,
    state: 'open',
    since_ms: null,
    expires_at_ms: null,
    pane: { id: 'p1', heading: 'Fix the build', agent: 'claude_code', project: null },
    title: 'Approve',
    sentence: null,
    risk: null,
    prompt: null,
    actions: [],
    resolution: null,
    ...over,
  }) as AttentionItem;

const snap = (...items: AttentionItem[]): AttentionSnapshot => ({ v: 1, rev: 1, counts: { blocking: items.length, ready: 0 }, items });

describe('what the pet hears', () => {
  it('open blocking items on a pane become needs, named by the agent label', () => {
    const needs = needsFromSnapshot(snap(item({})), (id) => (id === 'claude_code' ? 'Claude' : id));
    expect(needs).toEqual([{ key: 'approval:p1', paneId: 'p1', agent: 'Claude' }]);
  });

  it('resolved items, ready items and items without a pane are not needs', () => {
    const needs = needsFromSnapshot(
      snap(item({ state: 'resolved' }), item({ key: 'x', lane: 'ready' }), item({ key: 'y', pane: null })),
      (id) => id,
    );
    expect(needs).toEqual([]);
    expect(needsFromSnapshot(null, (id) => id)).toEqual([]);
  });

  it('a pane without an agent id falls back to its heading', () => {
    const needs = needsFromSnapshot(snap(item({ pane: { id: 'p9', heading: 'Notes', agent: null, project: null } })), (id) => id);
    expect(needs[0].agent).toBe('Notes');
  });

  it('a run that goes from running to idle is a finished run; other changes are not', () => {
    const known = new Map<string, string>();
    const paneOf = (id: string) => ({ id, agent_type: 'codex', status: 'idle' });
    expect(finishedRun(known, { pane_id: 'a', status: 'running' }, paneOf)).toBeNull();
    expect(finishedRun(known, { pane_id: 'a', status: 'idle' }, paneOf)?.id).toBe('a');
    // A pane first seen idle, an error and a pane waiting for input do not celebrate.
    expect(finishedRun(known, { pane_id: 'b', status: 'idle' }, paneOf)).toBeNull();
    finishedRun(known, { pane_id: 'c', status: 'running' }, paneOf);
    expect(finishedRun(known, { pane_id: 'c', status: 'error' }, paneOf)).toBeNull();
    finishedRun(known, { pane_id: 'd', status: 'running' }, paneOf);
    expect(finishedRun(known, { pane_id: 'd', status: 'waiting_input' }, paneOf)).toBeNull();
  });

  it('the companion pane never counts', () => {
    const known = new Map<string, string>([['companion-x', 'running']]);
    expect(finishedRun(known, { pane_id: 'companion-x', status: 'idle' }, () => undefined)).toBeNull();
  });

  it('quiet is the person\'s choice or the quiet hours', () => {
    const at = (h: number, m = 0) => new Date(2026, 10, 13, h, m);
    expect(petIsQuiet(false, QUIET_OFF, at(23))).toBe(false);
    expect(petIsQuiet(true, QUIET_OFF, at(12))).toBe(true);
    const hours = { enabled: true, start: 22 * 60, end: 7 * 60 };
    expect(petIsQuiet(false, hours, at(23))).toBe(true);
    expect(petIsQuiet(false, hours, at(3))).toBe(true);
    expect(petIsQuiet(false, hours, at(12))).toBe(false);
  });

  it('names an agent id plainly', () => {
    expect(plainAgentName('claude_code')).toBe('Claude code');
    expect(plainAgentName('')).toBe('Agent');
  });
});
