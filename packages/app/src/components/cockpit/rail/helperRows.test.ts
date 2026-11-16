import { describe, expect, it } from 'vitest';
import { helperRows } from './helperRows';

const pane = (id: string, parent?: string, title?: string, status = 'idle', started_as?: string) => ({ status, info: { id, title, parent_pane_id: parent, started_as } });

describe('helperRows', () => {
  it('lists only the direct helpers of the pane, with a title and agent', () => {
    const list = [pane('p'), pane('a', 'p', 'Check tests', 'running'), pane('b', 'p'), pane('c', 'a'), pane('other')];
    expect(helperRows(list, 'p', () => 'Codex')).toEqual([
      { id: 'a', title: 'Check tests', agent: 'Codex', agentType: null, status: 'running', kind: 'helper' },
      { id: 'b', title: 'Codex', agent: null, agentType: null, status: 'idle', kind: 'helper' },
    ]);
  });
  it('marks a minion, and leaves a spin-off out (it is a chat of its own, in the sidebar)', () => {
    const list = [pane('p'), pane('m', 'p', 'Review', 'running', 'minion'), pane('s', 'p', 'Fix tests', 'running', 'spin_off'), pane('h', 'p')];
    expect(helperRows(list, 'p', () => 'Claude').map((r) => [r.id, r.kind])).toEqual([
      ['m', 'minion'],
      ['h', 'helper'],
    ]);
  });
  it('names an untitled minion by the first words of its task and counts its time from its start; a helper keeps its agent name', () => {
    const task = 'Do these steps one at a time, each as its own shell command: 1) run git log';
    const list = [
      pane('p'),
      { status: 'running', info: { id: 'm', parent_pane_id: 'p', started_as: 'minion', created_at: 5000, origin: { task } } },
      { status: 'running', info: { id: 'h', parent_pane_id: 'p', created_at: 6000, origin: { task } } },
    ];
    const rows = helperRows(list, 'p', () => 'Claude');
    expect(rows[0]).toMatchObject({ id: 'm', title: expect.stringMatching(/^Do these steps one at a time, each as.*…$/), agent: 'Claude', startedAtMs: 5000 });
    expect(rows[1]).toMatchObject({ id: 'h', title: 'Claude', agent: null });
    expect(rows[1].startedAtMs).toBeUndefined();
  });
  it('is empty for a pane without helpers', () => {
    expect(helperRows([pane('p')], 'p', () => 'x')).toEqual([]);
  });
});
