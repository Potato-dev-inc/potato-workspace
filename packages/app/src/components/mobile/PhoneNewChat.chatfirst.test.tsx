// @vitest-environment jsdom
// The phone's new chat when the PC hides terminals (the PC's "Show terminals" setting is off): no Chat | Terminal pills, only
// chat agents, a quiet line for the agents that need a terminal, and the chat starts. With the setting on, the pills are as before.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeClient, PhoneNewChatOptions } from '../../lib/bridge-types';
import { PhoneNewChat } from './PhoneNewChat';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const both: PhoneNewChatOptions = {
  agents: [
    { id: 'claude', label: 'Claude', chat: true, terminal: true },
    { id: 'aider', label: 'Aider', chat: false, terminal: true },
  ],
  projects: [{ id: 'p1', name: 'shop', state: 'repo' }],
};
const hidden: PhoneNewChatOptions = {
  agents: [{ id: 'claude', label: 'Claude', chat: true, terminal: false }],
  projects: [{ id: 'p1', name: 'shop', state: 'repo' }],
  terminals: false,
  need_terminals: 1,
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function mount(options: PhoneNewChatOptions) {
  const phoneStartChat = vi.fn(async () => ({ pane_id: 'c1', agent: 'claude', lane: 'chat' }));
  const bridge = { phoneNewChat: async () => options, phoneStartChat, sendPaneMessage: vi.fn(async () => ({})) } as unknown as BridgeClient;
  await act(async () => {
    root.render(<PhoneNewChat bridge={bridge} canControl onClose={() => undefined} onStarted={() => undefined} />);
  });
  await act(async () => {});
  return { phoneStartChat };
}

describe('the phone new chat', () => {
  it('shows the Chat | Terminal pills when the PC allows terminals (and for an older PC that says nothing)', async () => {
    await mount(both);
    expect(host.querySelector('[data-testid="nc-lane"]')).not.toBeNull();
  });

  it('draws no Terminal pill when the PC hides terminals', async () => {
    await mount({ ...hidden, agents: [{ id: 'claude', label: 'Claude', chat: true, terminal: true }] });
    expect(host.querySelector('[data-testid="nc-lane"]')).toBeNull();
    expect(host.textContent).not.toContain('Terminal');
  });

  it('lists chat agents only and says how many need a terminal on the PC', async () => {
    await mount(hidden);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="nc-agent-pill"]')!.click());
    const sheet = document.body.textContent ?? '';
    expect(sheet).toContain('Claude');
    expect(sheet).not.toContain('Aider');
    expect(document.querySelector('[data-testid="nc-need-terminals"]')?.textContent).toContain('1 agent needs a terminal');
  });
});
