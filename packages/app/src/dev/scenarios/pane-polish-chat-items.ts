// Dev only: makes the harness's session_chat_open answer with a short conversation, so the Chat tab has turns.
// (The file is not a scenario: the runner lists every .ts here, so it exports nothing but a helper and a stub.)
type Invoke = (cmd: string, args?: unknown, opts?: unknown) => Promise<unknown>;

const ITEMS = [
  { kind: 'user', id: '10:0', at: null, text: 'hi' },
  { kind: 'assistant', id: '20:0', at: null, text: 'Hi! What can I help you with today?', model: null, finalAnswer: true },
  { kind: 'turnEnd', id: '30:0', at: null, outcome: 'completed', durationMs: 2000 },
];

export function withChatItems(): void {
  const w = window as unknown as { __TAURI_INTERNALS__?: { invoke: Invoke } };
  const internals = w.__TAURI_INTERNALS__;
  if (!internals) return;
  const real = internals.invoke.bind(internals);
  internals.invoke = (cmd, args, opts) =>
    cmd === 'session_chat_open' ? Promise.resolve({ available: true, reason: null, items: ITEMS, source: 'file', waitingFor: null, model: 'Haiku 5.5' }) : real(cmd, args, opts);
}
