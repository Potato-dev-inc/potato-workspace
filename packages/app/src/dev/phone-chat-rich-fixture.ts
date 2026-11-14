// A richer conversation for the phone redesign evidence shots: a one-line "hi" turn with a thought, then a working turn
// with a folded thought, folded steps, a plan (step 3 of 6), a code block with a long line, and a failed step.
import type { ChatItem, PhoneChatReply } from '../lib/sessionChatModel';

export function phoneRichReply(now: number): PhoneChatReply {
  const t = (secAgo: number) => new Date(now - secAgo * 1000).toISOString();
  const items: ChatItem[] = [
    { kind: 'user', id: 'u0', at: t(300), text: 'hi' },
    { kind: 'thinking', id: 't0', at: t(299), text: 'The person said hi. I will greet them and ask what they need.', durationMs: 2000 },
    { kind: 'assistant', id: 'a00', at: t(298), text: 'Hi! What would you like to work on?', model: null, finalAnswer: true },
    { kind: 'turnEnd', id: 'e0', at: t(297), outcome: 'completed', durationMs: 2000 },
    { kind: 'user', id: 'u1', at: t(120), text: 'Fix the pairing check so a phone that was removed cannot reconnect.' },
    { kind: 'thinking', id: 't1', at: t(118), text: 'I should read the pairing code first, then look at how a removed phone is recorded. The check probably runs before the removal is saved.', durationMs: 4000 },
    { kind: 'toolCall', id: 'c1', at: t(110), callId: 'k1', name: 'Read', summary: 'src/pairing.rs', paths: ['src/pairing.rs'] },
    { kind: 'toolResult', id: 'r1', at: t(108), callId: 'k1', ok: true, output: 'ok' },
    { kind: 'toolCall', id: 'c2', at: t(106), callId: 'k2', name: 'Read', summary: 'src/devices.rs', paths: ['src/devices.rs'] },
    { kind: 'toolResult', id: 'r2', at: t(104), callId: 'k2', ok: true, output: 'ok' },
    { kind: 'toolCall', id: 'c3', at: t(100), callId: 'k3', name: 'Bash', summary: 'cargo test pairing' },
    { kind: 'toolResult', id: 'r3', at: t(80), callId: 'k3', ok: false, output: '1 failing: removed_phone_cannot_reconnect' },
    { kind: 'assistant', id: 'a1', at: t(60), text: 'The check reads the device list before the removal is saved. The fix is to look at the saved list instead:\n\n```rust\nlet allowed = store.devices().iter().any(|d| d.id == request.device_id && !d.removed_at.is_some() && d.token_hash == hash(&request.token));\n```\n\nI will make that change and run the tests again.', model: null, finalAnswer: false },
    { kind: 'plan', id: 'p1', at: null, replace: true, items: [
      { text: 'Read the pairing code', status: 'completed' },
      { text: 'Find the removed phone check', status: 'completed' },
      { text: 'Fix the token check', status: 'in_progress' },
      { text: 'Write a test', status: 'pending' },
      { text: 'Run the full test suite', status: 'pending' },
      { text: 'Write the summary', status: 'pending' },
    ] },
    { kind: 'toolCall', id: 'c4', at: t(20), callId: 'k4', name: 'Edit', summary: 'src/pairing.rs', paths: ['src/pairing.rs'], writes: true },
    { kind: 'toolResult', id: 'r4', at: t(18), callId: 'k4', ok: true, output: 'edited' },
    { kind: 'toolCall', id: 'c5', at: t(10), callId: 'k5', name: 'Bash', summary: 'cargo test pairing' },
  ];
  return { available: true, reason: null, source: 'file', waitingFor: null, rev: 1, reset: false, items };
}
