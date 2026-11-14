// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import type { ChatTurn, ToolStep } from './sessionChatModel';
import { classifyLine, doneLines, evaluateDone, loadDoneMeans, saveDoneMeans } from './done-list';

const step = (id: string, command: string, status: 'ok' | 'error', output = ''): ToolStep => ({
  kind: 'tool',
  id,
  call: { kind: 'toolCall', id, at: null, callId: id, name: 'Bash', summary: command, input: { command } },
  result: { kind: 'toolResult', id: `${id}r`, at: null, callId: id, ok: status === 'ok', output },
  status,
});
const turn = (...steps: ToolStep[]): ChatTurn => ({ id: 't', user: null, steps, end: null, outcome: 'completed', durationMs: 1, ending: null, plan: null });
const usual = doneLines(null, { build: 'Build passes', tests: 'Tests pass' });

describe('done list', () => {
  beforeEach(() => localStorage.clear());

  it('defaults to the usual two lines', () => {
    expect(usual.map((l) => [l.text, l.kind])).toEqual([
      ['Build passes', 'build'],
      ['Tests pass', 'test'],
    ]);
  });

  it('a build that passed and tests that failed: tick, cross with the count', () => {
    const r = evaluateDone(usual, turn(step('1', 'npm run build', 'ok'), step('2', 'npx vitest run', 'error', 'Tests  2 failed | 10 passed')));
    expect(r.map((x) => [x.line.text, x.state, x.detail])).toEqual([
      ['Build passes', 'pass', ''],
      ['Tests pass', 'fail', '2 failed'],
    ]);
  });

  it('a line with no matching command is "not checked": never a guessed tick', () => {
    const r = evaluateDone(usual, turn(step('1', 'ls -la', 'ok')));
    expect(r.map((x) => x.state)).toEqual(['unchecked', 'unchecked']);
    expect(evaluateDone(usual, undefined).map((x) => x.state)).toEqual(['unchecked', 'unchecked']);
  });

  it('the last matching command decides: a fix after a failure turns the line green', () => {
    const r = evaluateDone(usual, turn(step('1', 'cargo test', 'error'), step('2', 'cargo test', 'ok')));
    expect(r[1].state).toBe('pass');
  });

  it('a command still running does not count', () => {
    const running: ToolStep = { ...step('1', 'npm test', 'ok'), result: null, status: 'running' };
    expect(evaluateDone(usual, turn(running))[1].state).toBe('unchecked');
  });

  it('lines the person writes are classified by their words, in English or Traditional Chinese', () => {
    expect(classifyLine('All tests are green')).toBe('test');
    expect(classifyLine('測試通過')).toBe('test');
    expect(classifyLine('It compiles')).toBe('other');
    expect(classifyLine('No new warnings')).toBe('lint');
    expect(classifyLine('建置通過')).toBe('build');
    expect(classifyLine('The page looks right')).toBe('other');
  });

  it('is saved per project, trimmed, and an empty list goes back to the usual two', () => {
    saveDoneMeans('c:/a', ['  Build passes ', '', 'Lint is clean']);
    expect(loadDoneMeans('c:/a')).toEqual(['Build passes', 'Lint is clean']);
    expect(loadDoneMeans('c:/b')).toBeNull();
    saveDoneMeans('c:/a', []);
    expect(loadDoneMeans('c:/a')).toBeNull();
  });
});
