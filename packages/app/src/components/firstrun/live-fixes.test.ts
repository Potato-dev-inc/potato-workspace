// Bugs found in a live run: folder gate, nested folders and the agent count.
import { describe, expect, it } from 'vitest';
import { refusal, withoutNested } from './StepProject';
import { usableAgents } from './model';
import { watchedRows } from './StepAgents';

describe('project folders', () => {
  it('a folder that is too big to copy is fine: the demo reads it in place', () => {
    expect(refusal({ ok: false, code: 'FOLDER_TOO_BIG' })).toBeNull();
    expect(refusal({ ok: true })).toBeNull();
    expect(refusal({ ok: false, code: 'FOLDER_TOO_BROAD' })).toBe('FOLDER_TOO_BROAD');
    expect(refusal({ ok: false, code: 'FOLDER_MISSING' })).toBe('FOLDER_MISSING');
  });
  it('a subfolder of a listed repository is not offered; the repository stays', () => {
    const list = [
      { path: 'D:\\pm-workspace\\packages\\app\\src-tauri', state: 'repo' },
      { path: 'D:\\pm-workspace', state: 'repo' },
      { path: 'D:\\pm-workspace2', state: 'repo' },
      { path: 'D:\\code\\old', state: 'missing' },
    ];
    expect(withoutNested(list).map((p) => p.path)).toEqual(['D:\\pm-workspace', 'D:\\pm-workspace2', 'D:\\code\\old']);
  });
  it('a subfolder of a folder that is gone stays', () => {
    const list = [{ path: 'D:/a', state: 'missing' }, { path: 'D:/a/b', state: 'repo' }];
    expect(withoutNested(list)).toHaveLength(2);
  });
});

describe('agent count', () => {
  it('counts only the rows that are shown', () => {
    const row = (id: string, state = 'unchecked', installed = true) => ({ id, label: id, state, installed, version: null, reason: '', install_hint: null, login_hint: null, can_test: true });
    const all = [row('claude'), row('codex'), row('cursor_agent'), row('opencode'), row('opencode_native')];
    expect(watchedRows(all as never).length).toBe(4);
    expect(usableAgents(watchedRows(all as never))).toHaveLength(4);
  });
});
