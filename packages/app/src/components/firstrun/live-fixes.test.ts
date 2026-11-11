// Bugs found in a live run: folder gate, nested folders, the agent count, the connection change sentence.
import { describe, expect, it } from 'vitest';
import { T } from './copy';
import { refusal, withoutNested } from './StepProject';
import { updateSentence } from './StepConnect';
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

describe('the connection change', () => {
  it('says where the entry pointed before', () => {
    const diff = '- command = "D:\\old\\mcp.exe"\n+ command = "D:\\new\\mcp.exe"';
    expect(updateSentence(diff)).toBe(T.connectPointsTo('D:\\old\\mcp.exe'));
  });
  it('a change that only adds a setting is not described as replacing the program', () => {
    // JSON: the old last line gains a comma, a new line is added. The removed line is not the program.
    const json = '-   "args": ["x"]\n+   "args": ["x"],\n+   "approve": "always"';
    expect(updateSentence(json)).toBe(T.connectFixSettings);
    expect(updateSentence('- }\n+ , "approve": true }')).toBe(T.connectFixSettings);
    expect(updateSentence('- timeout = 5\n+ approve = "always"')).toBe(T.connectFixSettings);
  });
  it('names the old program only when the command really changed', () => {
    expect(updateSentence('- command = "C:/old/mcp.exe"\n+ command = "C:/new/mcp.exe"')).toBe(T.connectPointsTo('C:/old/mcp.exe'));
    expect(updateSentence('-   "command": "npx",\n-   "args": ["-y", "gone-pkg"]\n+   "command": "C:/new/mcp.exe"')).toBe(T.connectPointsTo('npx -y gone-pkg'));
  });
  it('says missing settings are added when nothing is removed', () => {
    expect(updateSentence('+ args = ["x"]')).toBe(T.connectFixSettings);
  });
});
