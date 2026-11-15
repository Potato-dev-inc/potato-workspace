// Dev only (harness evidence): the desktop chat with "from <device>" under messages, and the strip "<device> is typing…"
// with Take back. Not a scenario file: the scenarios import this and mount it into the harness page.
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { AcpChatDock } from '../components/chat/AcpChatDock';
import { SessionChatView } from '../components/chat/SessionChatView';
import type { CockpitApi } from '../hooks/useCockpit';
import type { AcpChatState } from '../lib/acpChat';
import { fakeAcpApi } from '../lib/acpChatFake';
import { groupTurns, type ChatItem } from '../lib/sessionChatModel';

type Invoke = (cmd: string, args?: unknown, opts?: unknown) => Promise<unknown>;

const NAMES = { local: { name: "Ren's PC", kind: 'this_pc' }, phone1: { name: 'OPPO Reno13', kind: 'phone' }, 'link:mac': { name: "Ren's Mac", kind: 'pc' } };

const turn = (n: number, text: string, answer: string, from?: string): ChatItem[] => [
  { kind: 'user', id: `u${n}`, at: null, text, ...(from ? { from } : {}) },
  { kind: 'assistant', id: `a${n}`, at: null, text: answer, model: null, finalAnswer: true },
  { kind: 'turnEnd', id: `end:${n}`, at: null, outcome: 'completed', durationMs: 4000 },
];

const ITEMS: ChatItem[] = [
  ...turn(1, 'Add a retry to the invoice job.', 'Done. The job now retries three times with a short wait.'),
  ...turn(2, 'Also log each retry.', 'Added a log line for every retry.', 'phone1'),
  ...turn(3, 'Looks good. Run the tests.', 'All 42 tests pass.', 'link:mac'),
];

const STATE = {
  lane: 'acp', agent: 'claude', label: 'Claude', phase: 'idle', status: 'idle', turnInFlight: false, stopping: false, canSteer: false, turn: 3,
  title: null, usage: null, permissions: [], closed: false,
  drive: { driver: { id: 'phone1', name: 'OPPO Reno13', typing: true, typing_ms: 600_000 } },
} as unknown as AcpChatState;

export function mountSentFromDesktop(): void {
  const internals = (window as unknown as { __TAURI_INTERNALS__?: { invoke: Invoke } }).__TAURI_INTERNALS__;
  if (internals) {
    const real = internals.invoke.bind(internals);
    internals.invoke = (cmd, args, opts) => (cmd === 'device_names' ? Promise.resolve(NAMES) : real(cmd, args, opts));
  }
  const host = document.createElement('div');
  host.className = 'cockpit';
  host.style.cssText = 'position:fixed;inset:0;z-index:99999;background:var(--bg);color:var(--label);display:flex;flex-direction:column;overflow:auto';
  document.body.appendChild(host);
  const api = fakeAcpApi({ state: async () => STATE, takeBack: async () => 'phone1' });
  const c = { now: 5, asked: { questions: [], answerQuestion: async () => undefined, dismissQuestion: async () => undefined } } as unknown as CockpitApi;
  createRoot(host).render(
    createElement('div', { style: { display: 'flex', flexDirection: 'column', height: '100%' } }, [
      createElement('div', { key: 'chat', style: { flex: 1, minHeight: 0, display: 'flex' } }, createElement(SessionChatView, { state: 'ready', reason: null, source: 'acp', turns: groupTurns(ITEMS).turns, model: null, cliVersion: null, paneId: 'p-shot' })),
      createElement('div', { key: 'dock', style: { padding: '8px 20px 16px' } }, createElement(AcpChatDock, { c, paneId: 'p-shot', paneName: 'Claude', api })),
    ]),
  );
}
