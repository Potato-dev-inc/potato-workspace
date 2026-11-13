// Example conversation for the phone harness: you ask, the agent reads, a command fails, it edits, then answers.
// Served for every pane at `GET /panes/{id}/chat` so the phone opens in a real-looking chat.
import type { ChatItem, PhoneChatReply } from '../lib/sessionChatModel';

const at = (sec: number) => new Date(Date.UTC(2026, 10, 13, 1, 0, sec)).toISOString();

export const PHONE_CHAT_ITEMS: ChatItem[] = [
  { kind: 'session', id: 's0', at: null, model: 'Sonnet 5', cliVersion: null },
  { kind: 'user', id: 'u1', at: null, text: 'The login page loops back to itself after sign in. Can you fix it?' },
  { kind: 'assistant', id: 'a0', at: null, text: 'I will look at the login page and the route table first.', model: null, finalAnswer: false },
  { kind: 'toolCall', id: 'c1', at: at(0), callId: 'k1', name: 'Read', summary: 'src/pages/Login.tsx', paths: ['src/pages/Login.tsx'] },
  { kind: 'toolResult', id: 'r1', at: at(2), callId: 'k1', ok: true, output: 'ok' },
  { kind: 'toolCall', id: 'c2', at: at(3), callId: 'k2', name: 'Read', summary: 'src/routes.ts', paths: ['src/routes.ts'] },
  { kind: 'toolResult', id: 'r2', at: at(5), callId: 'k2', ok: true, output: 'ok' },
  { kind: 'toolCall', id: 'c3', at: at(6), callId: 'k3', name: 'Bash', summary: 'npm test -- login' },
  { kind: 'toolResult', id: 'r3', at: at(40), callId: 'k3', ok: false, output: '1 failing: redirects once after sign in' },
  { kind: 'toolCall', id: 'c4', at: at(41), callId: 'k4', name: 'Edit', summary: 'src/pages/Login.tsx', paths: ['src/pages/Login.tsx'], writes: true },
  { kind: 'toolResult', id: 'r4', at: at(43), callId: 'k4', ok: true, output: 'edited' },
  {
    kind: 'assistant',
    id: 'a1',
    at: null,
    text: 'Found it. After sign in the page sent you to `/login` again because the redirect target was read before the session was saved.\n\nI moved the redirect after the save and the test passes now.',
    model: null,
    finalAnswer: true,
  },
  { kind: 'turnEnd', id: 'e1', at: null, outcome: 'completed', durationMs: 252_000 },
];

export const PHONE_CHAT_REPLY: PhoneChatReply = { available: true, reason: null, source: 'file', waitingFor: null, rev: 1, reset: false, items: PHONE_CHAT_ITEMS };
