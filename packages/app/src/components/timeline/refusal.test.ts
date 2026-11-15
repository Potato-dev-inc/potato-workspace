// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { PM, row } from '../../dev/timeline-fixtures';
import { buildLanes } from './lanes-model';
import { panesInFolder, refusalFromMessage, refusalOf, type PaneLite } from './refusal';

function mark(over: Parameters<typeof row>[0]) {
  const lane = { project: over.project, name: 'x', folderGone: false, rows: [row(over)], lastMs: over.atMs };
  return buildLanes({ lanes: [lane] })[0].marks[0];
}

const pane = (cwd: string | null, status = 'idle'): PaneLite => ({ id: 'p', cwd, name: 'Chat', status });

describe('refusal', () => {
  it('maps the backend sentences, and only those, to a reason', () => {
    expect(refusalFromMessage('Undo is off for this folder: it is too big. Add big folders to .gitignore.')).toBe('tooBig');
    expect(refusalFromMessage('Checkpoints are turned off in Settings.')).toBe('off');
    expect(refusalFromMessage('The folder is gone.')).toBe('folder');
    expect(refusalFromMessage('That checkpoint no longer exists.')).toBe('gone');
    expect(refusalFromMessage('A run is still open on this pane. Interrupt it first, then undo.')).toBe('open');
    expect(refusalFromMessage('The agent is working. Interrupt it first, then undo.')).toBe('running');
    expect(refusalFromMessage('Something else')).toBe('other');
  });

  it('finds the chats working in a folder, in a folder inside it, or around it', () => {
    const panes = [pane(PM), pane(`${PM}/.worktrees/a`), pane(String.raw`c:\WORK\pm-workspace` + '\\'), pane('C:/work/pm-workspace-2'), pane(null), pane('C:/work')];
    expect(panesInFolder(panes, PM)).toHaveLength(4);
  });

  it('refuses in order: folder gone, too old, a chat working, then what the backend said', () => {
    const live = mark({ project: PM, key: 'a', id: '1', atMs: 1 });
    expect(refusalOf(live, [], null)).toBeNull();
    expect(refusalOf(live, [pane(PM, 'running')], null)).toBe('running');
    expect(refusalOf(live, [pane(PM, 'idle')], null)).toBeNull();
    expect(refusalOf(live, [], 'Checkpoints are turned off in Settings.')).toBe('off');
    expect(refusalOf(mark({ project: PM, key: 'a', id: '1', atMs: 1, gone: true }), [pane(PM, 'running')], null)).toBe('gone');
    expect({ ...live, folderGone: true, faded: true }).toMatchObject({ folderGone: true });
    expect(refusalOf({ ...live, folderGone: true, faded: true }, [], null)).toBe('folder');
  });
});
