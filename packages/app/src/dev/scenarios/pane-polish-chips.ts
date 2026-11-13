import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import { AcpConfigChips } from '../../components/chat/AcpConfigChips';
import type { AcpChatState } from '../../lib/acpChat';
import type { HarnessScenario } from '../types';

// The settings chips under the message box: each says what it sets (a setting of an unknown kind shows its name).
const STATE = {
  lane: 'acp', agent: 'Agent', label: 'Agent', phase: 'idle', status: 'idle', turnInFlight: false, stopping: false, canSteer: true, turn: 1,
  title: 'x', usage: null, permissions: [], closed: false,
  configOptions: [
    { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'manual', options: [{ value: 'manual', name: 'Manual', description: 'Asks before it changes anything' }, { value: 'auto', name: 'Auto edit' }] },
    { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'haiku', options: [{ value: 'haiku', name: 'Haiku 5.5' }, { value: 'opus', name: 'Opus' }] },
    { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: 'low', options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }, { value: 'max', name: 'Max' }, { value: 'xhigh', name: 'Extra' }] },
    { id: 'style', name: 'Output style', category: null, type: 'select', currentValue: 'default', options: [{ value: 'default', name: 'Default' }, { value: 'explain', name: 'Explanatory' }] },
  ],
} as unknown as AcpChatState;

const s: HarnessScenario = {
  name: 'pane-polish-chips',
  route: 'cockpit',
  window: { width: 900, height: 200 },
  after: async (dom) => {
    await dom.sleep(300);
    const host = document.createElement('div');
    host.className = 'cockpit';
    host.style.cssText = 'position:fixed;inset:0;z-index:99999;background:var(--bg);color:var(--label);padding:24px';
    document.body.appendChild(host);
    createRoot(host).render(createElement(AcpConfigChips, { paneId: 'p', state: STATE, api: { setConfig: async () => STATE } }));
    await dom.sleep(400);
  },
};
export default s;
