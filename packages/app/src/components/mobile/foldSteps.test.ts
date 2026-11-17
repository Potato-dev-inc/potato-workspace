// The live line and the running step (pure). Shows the words of a step, never its command text.
import { afterEach, describe, expect, it } from 'vitest';
import { setLanguagePref } from '../../i18n';
import { groupTurns, type ChatItem } from '../../lib/sessionChat';
import type { ToolStep } from '../../lib/sessionChatModel';
import { liveLine, liveText, runningStep } from './foldSteps';

afterEach(() => setLanguagePref('en', false));

const call = (n: number, name: string, summary: string, paths?: string[]): ChatItem => ({
  kind: 'toolCall',
  id: `c${n}`,
  at: null,
  callId: `k${n}`,
  name,
  summary,
  paths: paths ?? [summary],
});
const ok = (n: number): ChatItem => ({ kind: 'toolResult', id: `r${n}`, at: null, callId: `k${n}`, ok: true, output: 'fine' });

/** One tool step as the turn model builds it: running when no result came, finished otherwise. */
function stepOf(items: ChatItem[]): ToolStep {
  const step = groupTurns([{ kind: 'user', id: 'u', at: null, text: 'go' }, ...items]).turns[0]!.steps.find((s) => s.kind === 'tool');
  return step as ToolStep;
}
const running = (name: string, summary: string, paths?: string[]) => stepOf([call(1, name, summary, paths)]);

describe('liveLine', () => {
  it('reads a file: a muted verb, then the file name (never the folder)', () => {
    const line = liveLine(running('Read', '/repo/src/login.ts', ['/repo/src/login.ts']));
    expect(line).toEqual({ verb: 'Reading', thing: 'login.ts' });
    expect(liveText(line)).toBe('Reading login.ts');
  });

  it('takes the file name from a Windows path too', () => {
    const win = 'src\\a\\b.ts';
    expect(liveText(liveLine(running('Edit', win, [win])))).toBe('Editing b.ts');
  });

  it('says "Reading files" when a read has no path', () => {
    expect(liveText(liveLine(running('Read', '', [])))).toBe('Reading files');
  });

  it('says "Running a command" for a shell step and never shows its command', () => {
    const text = liveText(liveLine(running('Bash', 'rm -rf ../build-cache')));
    expect(text).toBe('Running a command');
    expect(text).not.toContain('rm');
    expect(text).not.toContain('build-cache');
  });

  it('says "Running tests" when the command is a test run', () => {
    expect(liveText(liveLine(running('Bash', 'npm test')))).toBe('Running tests');
    expect(liveText(liveLine(running('Bash', 'cargo test --lib foo')))).toBe('Running tests');
    expect(liveText(liveLine(running('Bash', 'npm run build')))).toBe('Running a command');
  });

  it('names search, web, helper and other tools in plain words', () => {
    expect(liveText(liveLine(running('Grep', 'foo')))).toBe('Searching');
    expect(liveText(liveLine(running('WebFetch', 'https://example.com')))).toBe('Searching the web');
    expect(liveText(liveLine(running('Agent', 'review the diff')))).toBe('Starting an agent');
    expect(liveText(liveLine(running('Frobnicate', 'x')))).toBe('Using a tool');
  });

  it('says the live line in Chinese for zh-TW', () => {
    setLanguagePref('zh-TW', false);
    expect(liveText(liveLine(running('Read', 'a/login.ts', ['a/login.ts'])))).toBe('讀取 login.ts');
    expect(liveText(liveLine(running('Bash', 'npm test')))).toBe('執行測試');
    expect(liveText(liveLine(running('Bash', 'rm -rf x')))).toBe('執行指令');
  });
});

describe('runningStep', () => {
  it('returns the newest step that still runs, or null when none runs', () => {
    const done = stepOf([call(1, 'Read', 'a.ts'), ok(1)]);
    const busy = stepOf([call(2, 'Bash', 'npm test')]);
    expect(runningStep([done, busy])).toBe(busy);
    expect(runningStep([done])).toBeNull();
  });
});
