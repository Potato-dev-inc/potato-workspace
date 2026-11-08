import { ActivityLine } from '../components/chat/ActivityLine';
import { ChatMarkdown } from '../components/chat/ChatMarkdown';
import { PlanCard } from '../components/chat/PlanCard';
import { ToolRow } from '../components/chat/ToolRow';
import type { PlanItem, ToolStep, ToolCallItem, ToolResultItem } from '../lib/sessionChatModel';

// The agent's cards in one transcript: a folded group of tool rows, an expanded command with its terminal output, a
// failed command, an edit as a file card with two hunks, a running activity line, the task list at 2 of 4, and a
// reply with a code block. Real components, real CSS (imported by each component).

const T0 = Date.now() - 42_000;
const at = (ms: number) => new Date(T0 + ms).toISOString();

function call(id: string, name: string, summary: string, input: unknown, paths: string[] = [], ms = 0, writes = false): ToolCallItem {
  return { kind: 'toolCall', id, at: at(ms), callId: id, name, summary, input, paths, writes };
}

function result(id: string, callId: string, output: string, ok: boolean, ms: number): ToolResultItem {
  return { kind: 'toolResult', id, at: at(ms), callId, ok, output };
}

function step(c: ToolCallItem, r: ToolResultItem | null, status: ToolStep['status']): ToolStep {
  return { kind: 'tool', id: c.id, call: c, result: r, status };
}

const PARSER_PATCH = [
  '*** Update File: src/parser.ts',
  '@@ function splitLines(text: string)',
  '-  return text.split("\\n");',
  '+  // Windows files end lines with CRLF; keep the split working for both.',
  '+  return text.split(/\\r?\\n/);',
  ' }',
  '@@ function readToken(src: string, pos: number)',
  '-  const token = src.slice(pos, pos + 1);',
  '-  if (token === "") return null;',
  '+  const token = src.charAt(pos);',
  '+  if (token === "") return null; // end of input',
  '   return { token, pos: pos + 1 };',
].join('\n');

// Group of finished reads and one command, folded in the transcript.
const GROUP: ToolStep[] = [
  step(call('g1', 'Bash', 'npm test -- parser', { command: 'npm test -- parser' }, [], 1000), result('g1r', 'g1', 'Tests: 41 passed', true, 9000), 'ok'),
  step(call('g2', 'Read', 'src/parser.ts', { path: 'src/parser.ts' }, ['src/parser.ts'], 9500), result('g2r', 'g2', '…', true, 9800), 'ok'),
  step(call('g3', 'Read', 'src/lexer.ts', { path: 'src/lexer.ts' }, ['src/lexer.ts'], 10000), result('g3r', 'g3', '…', true, 10300), 'ok'),
  step(call('g4', 'Read', 'src/parser.test.ts', { path: 'src/parser.test.ts' }, ['src/parser.test.ts'], 10400), result('g4r', 'g4', '…', true, 10700), 'ok'),
  step(call('g5', 'Read', 'package.json', { path: 'package.json' }, ['package.json'], 10800), result('g5r', 'g5', '…', true, 11000), 'ok'),
];

// One command, expanded: the terminal output.
const TERMINAL: ToolStep = step(
  call('t1', 'Bash', 'npm test -- parser', { command: 'npm test -- parser' }, [], 11500),
  result(
    't1r',
    't1',
    [
      ' PASS  src/parser.test.ts',
      '  parser',
      '    ✓ reads a CRLF file line by line (4 ms)',
      '    ✓ keeps empty lines in the middle (1 ms)',
      '    ✓ stops at the end of input (1 ms)',
      '',
      'Test Suites: 1 passed, 1 total',
      'Tests:       42 passed, 42 total',
      'Time:        2.84 s',
    ].join('\n'),
    true,
    14200,
  ),
  'ok',
);

// One failed command.
const FAILED: ToolStep = step(
  call('f1', 'Bash', 'npm run lint', { command: 'npm run lint' }, [], 14500),
  result('f1r', 'f1', ['src/parser.ts', '  14:7  error  "token" is assigned a value but never used  no-unused-vars', '', '✖ 1 problem (1 error, 0 warnings)'].join('\n'), false, 15900),
  'error',
);

// An edit as a file card: two hunks.
const EDIT: ToolStep = step(
  call('e1', 'Edit', 'src/parser.ts', { patch: PARSER_PATCH }, ['src/parser.ts'], 16200, true),
  result('e1r', 'e1', 'Edited src/parser.ts', true, 16900),
  'ok',
);

// The turn in progress: three steps, the last one running.
const LIVE: ToolStep[] = [
  step(call('l1', 'Read', 'src/parser.ts', { path: 'src/parser.ts' }, ['src/parser.ts'], 0), result('l1r', 'l1', '…', true, 400), 'ok'),
  step(call('l2', 'Edit', 'src/parser.ts', { patch: PARSER_PATCH }, ['src/parser.ts'], 1200, true), result('l2r', 'l2', 'Edited src/parser.ts', true, 2100), 'ok'),
  step(call('l3', 'Bash', 'npm run build', { command: 'npm run build' }, [], 2600), null, 'running'),
];

const PLAN: PlanItem[] = [
  { text: 'Read the parser and its tests', status: 'completed', taskId: 'p1' },
  { text: 'Handle CRLF line endings in splitLines', status: 'completed', taskId: 'p2' },
  { text: 'Run the build and the parser tests', status: 'in_progress', taskId: 'p3' },
  { text: 'Update the changelog', status: 'pending', taskId: 'p4' },
];

const REPLY = [
  'The CRLF split and the end-of-input check are in. The lint error is gone, and the parser tests pass.',
  '',
  'The split now accepts both line endings:',
  '',
  '```ts',
  'export function splitLines(text: string): string[] {',
  '  return text.split(/\\r?\\n/);',
  '}',
  '```',
  '',
  'Next I am running the build, then the changelog entry.',
].join('\n');

export function Preview() {
  return (
    <div className="cockpit" style={{ position: 'fixed', inset: 0, zIndex: 99999, display: 'block', background: 'var(--bg)', color: 'var(--label)', overflow: 'auto', padding: 24 }}>
      <div style={{ maxWidth: 720, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="ck-chat-bubble ck-chat-bubble--user" style={{ alignSelf: 'flex-end', maxWidth: '80%' }}>
          Fix the CRLF bug in the parser and make sure lint is clean.
        </div>
        <PlanCard items={PLAN} />
        <ActivityLine steps={GROUP} live={false} fromScreen={false} verbose={false} />
        <ToolRow step={TERMINAL} fromScreen={false} defaultOpen />
        <ToolRow step={FAILED} fromScreen={false} defaultOpen />
        <ToolRow step={EDIT} fromScreen={false} defaultOpen />
        <ActivityLine steps={LIVE} live fromScreen={false} verbose={false} />
        <div style={{ fontSize: 14, lineHeight: 1.5 }}>
          <ChatMarkdown text={REPLY} />
        </div>
      </div>
    </div>
  );
}
