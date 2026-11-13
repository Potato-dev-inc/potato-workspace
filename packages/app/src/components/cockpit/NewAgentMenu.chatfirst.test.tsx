// @vitest-environment jsdom
// The "+" menu with "Show terminals" OFF: no Chat | Terminal switch, no shell rows, only agents that can chat, a click starts
// a chat whatever the saved switch says, one quiet line for the agents left out, and no "Start in terminal" way out.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcpLaneAgent } from '../../lib/acpChat';
import type { AccountsApi } from '../../lib/accounts';
import { forceShowTerminals } from '../../lib/showTerminals';
import { NewAgentMenu } from './NewAgentMenu';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ENTRIES = [
  { type: 'claude', label: 'Claude' },
  { type: 'aider', label: 'Aider' },
  { type: 'goose', label: 'Goose' },
  { type: 'powershell', label: 'PowerShell', shell: true },
];
const accounts = { list: async () => ({ agents: [], accounts: [] }) } as unknown as AccountsApi;
const chatAgent = (id: string): AcpLaneAgent => ({ id, label: id, lane: 'terminal', effective_lane: 'terminal', disabled: false, disabled_note: null });

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  forceShowTerminals(true);
  await act(async () => root.unmount());
  host.remove();
});

async function mount(mode: 'chat' | 'terminal' = 'chat', onChatStart: (id: string) => Promise<void> = vi.fn(async () => undefined)) {
  const onStart = vi.fn();
  await act(async () => {
    root.render(<NewAgentMenu entries={ENTRIES} readyAgents={new Set()} onStart={onStart} onClose={vi.fn()} accountsApi={accounts} chat={{ mode, onMode: vi.fn(), agents: [chatAgent('claude')], onStart: onChatStart }} />);
  });
  return { onStart, onChatStart };
}
const labels = () => [...host.querySelectorAll('button.ck-menu-item')].map((b) => b.textContent ?? '');
const row = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button.ck-menu-item')].find((b) => b.textContent?.includes(label))!;

describe('the + menu with terminals hidden', () => {
  it('lists only agents that can chat, no shell, and no Chat | Terminal switch', async () => {
    forceShowTerminals(false);
    await mount();
    expect(host.querySelector('[data-testid="start-mode"]')).toBeNull();
    expect(labels().some((l) => l.includes('Claude'))).toBe(true);
    expect(labels().some((l) => l.includes('Aider'))).toBe(false);
    expect(labels().some((l) => l.includes('PowerShell'))).toBe(false);
  });

  it('says once how many agents need terminals (the shell is not an agent)', async () => {
    forceShowTerminals(false);
    await mount();
    const line = host.querySelector('[data-testid="need-terminals"]');
    expect(line?.textContent).toContain('2 agents need terminals');
    expect(line?.textContent).toContain('Show terminals');
  });

  it('a click starts a chat even when the saved switch says Terminal', async () => {
    forceShowTerminals(false);
    const { onStart, onChatStart } = await mount('terminal');
    await act(async () => row('Claude').click());
    expect(onChatStart).toHaveBeenCalledWith('claude');
    expect(onStart).not.toHaveBeenCalled();
  });

  it('with terminals shown the menu is as before: the switch, every agent, the shell, no line', async () => {
    forceShowTerminals(true);
    const { onStart } = await mount('terminal');
    expect(host.querySelector('[data-testid="start-mode"]')).not.toBeNull();
    expect(labels().some((l) => l.includes('Aider'))).toBe(true);
    expect(labels().some((l) => l.includes('PowerShell'))).toBe(true);
    expect(host.querySelector('[data-testid="need-terminals"]')).toBeNull();
    await act(async () => row('Aider').click());
    expect(onStart).toHaveBeenCalledWith('aider', undefined);
  });

  it('a failed chat start offers no "Start in terminal"', async () => {
    forceShowTerminals(false);
    await mount('chat', async () => Promise.reject(new Error('ACP_START_FAILED: It broke. The terminal can run this agent instead.')));
    await act(async () => row('Claude').click());
    await act(async () => {});
    expect(host.querySelector('[data-testid="chat-start-failed"]')).not.toBeNull();
    expect(host.textContent).not.toContain('Start in terminal');
  });
});
