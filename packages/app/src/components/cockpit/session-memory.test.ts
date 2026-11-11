// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  endedLine,
  endedTerminals,
  forgetTerminal,
  parseSessionMemory,
  readSessionMemory,
  rememberSelectedTab,
  rememberableTerminal,
  SESSION_MEMORY_KEY,
  writeSessionMemory,
} from './session-memory';
import type { PaneInfo } from '../../lib/tauri-types';

const info = (extra: Partial<PaneInfo> = {}): PaneInfo => ({
  id: 'p1', agent_type: 'claude', pid: 1, status: 'idle', created_at: 0, last_output_at: null, cwd: 'C:\\w', cols: 80, rows: 24, ...extra,
});
const EMPTY = { selected: null, terminals: [] };

beforeEach(() => localStorage.clear());

describe('session memory', () => {
  it('tolerates missing and corrupt text', () => {
    expect(parseSessionMemory(null)).toEqual(EMPTY);
    expect(parseSessionMemory('{nope')).toEqual(EMPTY);
    expect(parseSessionMemory('42')).toEqual(EMPTY);
    expect(parseSessionMemory('{"selected":{"id":5},"terminals":"x"}')).toEqual(EMPTY);
  });

  it('keeps good pieces and drops bad ones, including repeats', () => {
    const raw = JSON.stringify({
      selected: { id: 'p1', tab: 'changes' },
      terminals: [{ id: 'a', agent: 'claude', cwd: '/x', title: 'T' }, { id: 'a', agent: 'claude', cwd: '/y' }, { id: 'b' }, null, { id: 'c', agent: 'codex', cwd: '' }],
    });
    const m = parseSessionMemory(raw);
    expect(m.selected).toEqual({ id: 'p1', tab: 'changes' });
    expect(m.terminals.map((t) => t.id)).toEqual(['a', 'c']);
    expect(m.terminals[0].title).toBe('T');
  });

  it('reads nothing when storage throws', () => {
    const orig = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error('blocked');
    };
    try {
      expect(readSessionMemory()).toEqual(EMPTY);
    } finally {
      Storage.prototype.getItem = orig;
    }
  });

  it('lists only the terminals that are gone', () => {
    const m = { selected: null, terminals: [{ id: 'a', agent: 'x', cwd: '' }, { id: 'b', agent: 'y', cwd: '' }] };
    expect(endedTerminals(m, (id) => id === 'a').map((t) => t.id)).toEqual(['b']);
  });

  it('remembers terminals but not chats, helpers or companions', () => {
    expect(rememberableTerminal(info())).toEqual({ id: 'p1', agent: 'claude', cwd: 'C:\\w' });
    expect(rememberableTerminal(info({ lane: 'acp' }))).toBeNull();
    expect(rememberableTerminal(info({ parent_pane_id: 'boss' }))).toBeNull();
    expect(rememberableTerminal(info({ id: 'companion-abc' }))).toBeNull();
  });

  it('saves the tab only for the selected pane, and forgets a closed terminal', () => {
    writeSessionMemory({ selected: { id: 'p1' }, terminals: [{ id: 'p1', agent: 'claude', cwd: '' }] });
    rememberSelectedTab('p2', 'chat');
    expect(readSessionMemory().selected).toEqual({ id: 'p1' });
    rememberSelectedTab('p1', 'chat');
    expect(readSessionMemory().selected).toEqual({ id: 'p1', tab: 'chat' });
    forgetTerminal('p1');
    expect(readSessionMemory().terminals).toEqual([]);
    expect(localStorage.getItem(SESSION_MEMORY_KEY)).toContain('selected');
  });

  it('words the line for one and for many', () => {
    expect(endedLine(1)).toBe('1 terminal agent ended with the last restart.');
    expect(endedLine(3)).toBe('3 terminal agents ended with the last restart.');
  });
});
