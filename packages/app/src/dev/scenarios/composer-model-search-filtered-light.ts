import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import { AcpConfigChips } from '../../components/chat/AcpConfigChips';
import type { AcpChatState } from '../../lib/acpChat';
import type { HarnessScenario } from '../types';

// The model list above the message box has a search box (filtered, light).
const NAMES = ['opencode/Beam Free', 'opencode/Big Pickle', 'opencode/DeepSeek V4.1 Flash Free', 'opencode/Hy4 flash Free', 'opencode/Qwen 3 Coder Free', 'opencode/Grok Code Fast', 'openai/GPT 5', 'openai/GPT 5 mini', 'claude/Opus', 'claude/Sonnet', 'claude/Haiku', 'gemini/Gemini 3 Flash', 'gemini/Gemini 3 Pro'];
const STATE = {
  lane: 'acp', agent: 'Agent', label: 'Agent', phase: 'idle', status: 'idle', turnInFlight: false, stopping: false, canSteer: true, turn: 1,
  title: 'x', usage: null, permissions: [], closed: false,
  configOptions: [
    { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: NAMES[1], options: NAMES.map((v) => ({ value: v, name: v })) },
    { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: 'default', options: [{ value: 'none', name: 'None' }, { value: 'high', name: 'High' }, { value: 'default', name: 'Default' }] },
  ],
} as unknown as AcpChatState;

const s: HarnessScenario = {
  name: 'composer-model-search-filtered-light',
  route: 'cockpit',
  theme: 'light',
  window: { width: 700, height: 420 },
  after: async (dom) => {
    await dom.sleep(300);
    const host = document.createElement('div');
    host.className = 'cockpit';
    host.style.cssText = 'position:fixed;inset:0;z-index:99999;background:var(--bg);color:var(--label);padding:24px;display:flex;align-items:flex-end';
    document.body.appendChild(host);
    createRoot(host).render(createElement(AcpConfigChips, { paneId: 'p', state: STATE, api: { setConfig: async () => STATE } }));
    await dom.sleep(300);
    await dom.click('[data-chip-id="model"] button');
    await dom.sleep(300);
    const box = document.querySelector<HTMLInputElement>('input.ck-pop-search');
    if (box) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(box, 'flash');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    }
    await dom.sleep(300);
  },
};
export default s;
