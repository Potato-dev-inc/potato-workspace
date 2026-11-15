// Dev only: makes the harness's session_chat_open answer with a working conversation (usage, plan, files written, a tool
// server), so the right panel has data in the evidence shots. Not a scenario: it exports a helper and a stub.
type Invoke = (cmd: string, args?: unknown, opts?: unknown) => Promise<unknown>;

const call = (n: number, name: string, path: string, writes: boolean) => ({ kind: 'toolCall', id: `${n}:0`, at: null, callId: `c${n}`, name, summary: path, paths: [path], writes });

const ITEMS = [
  { kind: 'session', id: '1:0', at: null, model: 'Sonnet 4.5', cliVersion: '2.1.0' },
  { kind: 'user', id: '10:0', at: null, text: 'Rebuild the right panel as calm sections and drop the result strip.' },
  { kind: 'assistant', id: '20:0', at: null, text: 'I will replace the stacked cards with plain sections and move the result numbers into Changes.', model: null, finalAnswer: false },
  call(30, 'Write', 'C:/work/pm-workspace/mock/right-panel.html', true),
  call(31, 'Write', 'C:/work/pm-workspace/notes/RIGHT-PANEL.md', true),
  call(32, 'Write', 'C:/work/pm-workspace/mock/panel-dark.png', true),
  call(33, 'Write', 'C:/work/pm-workspace/mock/tokens.json', true),
  call(34, 'Edit', 'C:/work/pm-workspace/packages/app/src/SessionRail.tsx', true),
  { kind: 'toolCall', id: '40:0', at: null, callId: 'c40', name: 'mcp__github__list_prs', summary: 'list prs', paths: [], writes: false },
  { kind: 'toolCall', id: '41:0', at: null, callId: 'c41', name: 'mcp__figma__get_file', summary: 'get file', paths: [], writes: false },
  { kind: 'usage', id: '50:0', at: null, inputTokens: 80_000, outputTokens: 16_000, contextWindow: 200_000 },
  { kind: 'plan', id: '60:0', at: null, replace: true, items: [{ text: 'Sections', status: 'completed' }, { text: 'Fold and resize', status: 'in_progress' }, { text: 'Colour tokens', status: 'pending' }] },
];

export function withRailData(paneId: string): void {
  const w = window as unknown as { __TAURI_INTERNALS__?: { invoke: Invoke } };
  const internals = w.__TAURI_INTERNALS__;
  if (!internals) return;
  const real = internals.invoke.bind(internals);
  internals.invoke = (cmd, args, opts) =>
    cmd === 'session_chat_open' && (args as { paneId?: string } | undefined)?.paneId === paneId
      ? Promise.resolve({ available: true, reason: null, items: ITEMS, source: 'file', waitingFor: null, model: 'Sonnet 4.5' })
      : real(cmd, args, opts);
}
