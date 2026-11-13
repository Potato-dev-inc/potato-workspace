// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentHealth } from '../agent-health';
import { loadTestMemory, rememberTest, timeOf } from './test-memory';

const result = (over: Partial<AgentHealth>): AgentHealth => ({
  id: 'claude', label: 'Claude', state: 'ready', installed: true, version: '1', reason: 'Ready.', install_hint: null, login_hint: null, can_test: true, ...over,
});

describe('test memory', () => {
  beforeEach(() => window.localStorage.clear());

  it('remembers the last Test per agent and survives a reload of the reader', () => {
    rememberTest(result({}), 1000);
    rememberTest(result({ id: 'codex', state: 'error', reason: 'It failed: x' }), 2000);
    rememberTest(result({ state: 'needs_login', reason: 'sign in' }), 3000);
    const m = loadTestMemory();
    expect(m.claude).toEqual({ state: 'needs_login', reason: 'sign in', at: 3000 });
    expect(m.codex.state).toBe('error');
  });

  it('bad stored data reads as nothing, and a time reads as hours and minutes', () => {
    window.localStorage.setItem('pm.setupcheck.tests.v1', '[1,2');
    expect(loadTestMemory()).toEqual({});
    expect(timeOf(new Date(2026, 10, 13, 14, 5).getTime())).toMatch(/\d/);
  });
});
