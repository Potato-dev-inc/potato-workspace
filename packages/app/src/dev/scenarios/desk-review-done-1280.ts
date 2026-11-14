import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { DoneListFor } from '../../components/cockpit/DoneList';
import type { ChatTurn, ToolStep } from '../../lib/sessionChatModel';
import type { HarnessScenario } from '../types';

// The Done list under a chat's result card: the build passed, the tests failed (with "Fix it"), and one line nothing
// checked (1280 wide; PM_EVIDENCE_THEME picks dark or light). Drawn alone over the cockpit, like the chips preview.
const step = (id: string, command: string, status: 'ok' | 'error', output = ''): ToolStep => ({
  kind: 'tool',
  id,
  call: { kind: 'toolCall', id, at: null, callId: id, name: 'Bash', summary: command, input: { command } },
  result: { kind: 'toolResult', id: `${id}r`, at: null, callId: id, ok: status === 'ok', output },
  status,
});
const TURN: ChatTurn = {
  id: 't1',
  user: null,
  steps: [step('1', 'npm run build', 'ok'), step('2', 'npx vitest run', 'error', 'Tests  2 failed | 41 passed')],
  end: { kind: 'turnEnd', id: 'e1', at: null, outcome: 'completed', durationMs: 90_000 },
  outcome: 'completed',
  durationMs: 90_000,
  ending: null,
  plan: null,
};

const s: HarnessScenario = {
  name: 'desk-review-done-1280',
  route: 'cockpit',
  window: { width: 1280, height: 260 },
  after: async (dom) => {
    localStorage.setItem('pm-done-means:c:/work/shop', JSON.stringify(['Build passes', 'Tests pass', 'The page looks right in the browser']));
    await dom.sleep(300);
    const host = document.createElement('div');
    host.className = 'cockpit';
    host.style.cssText = 'position:fixed;inset:0;z-index:99999;background:var(--bg);color:var(--label);padding:24px;display:block;width:100%';
    document.body.appendChild(host);
    createRoot(host).render(createElement(DoneListFor, { paneId: 'p1', cwd: 'C:/work/shop', turn: TURN }));
    await dom.sleep(500);
  },
};
export default s;
