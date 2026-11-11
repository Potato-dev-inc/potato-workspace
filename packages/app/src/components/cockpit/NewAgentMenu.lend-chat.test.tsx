// @vitest-environment jsdom
// A sign-in lent by another PC can start a CHAT too: with Chat on and a borrowed sign-in for the agent, the menu asks
// which sign-in (like a terminal does) and starts the chat under the one picked. With no borrowed sign-in a chat starts at
// once, as before.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcpLaneAgent } from '../../lib/acpChat';
import type { AccountsApi } from '../../lib/accounts';
import { NewAgentMenu } from './NewAgentMenu';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ENTRIES = [{ type: 'claude', label: 'Claude' }];
const lane = (): AcpLaneAgent => ({ id: 'claude', label: 'Claude', lane: 'acp', effective_lane: 'acp', disabled: false, disabled_note: null });
const withBorrowed = (borrowed: boolean): AccountsApi =>
  ({
    list: async () => ({
      agents: [],
      accounts: [{ id: 'acct-work', agent_id: 'claude', label: 'Work', home: 'C:\\work' }],
      borrowed: borrowed ? [{ id: 'lend:g1', agent_id: 'claude', label: "Leo's PC (lent)", ends_ms: Date.now() + 134 * 60_000, grant_id: 'g1' }] : [],
    }),
  }) as unknown as AccountsApi;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function mount(borrowed: boolean) {
  const onStart = vi.fn(async () => undefined);
  const onStartTerminal = vi.fn(async () => undefined);
  const onClose = vi.fn();
  await act(async () => {
    root.render(
      <NewAgentMenu
        entries={ENTRIES}
        readyAgents={new Set()}
        onStart={vi.fn()}
        onClose={onClose}
        accountsApi={withBorrowed(borrowed)}
        chat={{ mode: 'chat', onMode: vi.fn(), agents: [lane()], onStart, onStartTerminal, terminalChat: [] }}
      />,
    );
  });
  await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
  return { onStart, onStartTerminal, onClose };
}
const item = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button.ck-menu-item')].find((b) => b.textContent?.includes(text))!;
const click = (el: HTMLElement) => act(async () => el.click());

describe('Chat on a borrowed sign-in', () => {
  it('asks which sign-in, lists the lent one with its time left, and starts the chat under it', async () => {
    const { onStart, onClose } = await mount(true);
    await click(item('Claude'));
    expect(onStart).not.toHaveBeenCalled();
    const labels = [...host.querySelectorAll('button.ck-menu-item')].map((b) => b.textContent);
    expect(labels[0]).toBe('Default sign-in');
    expect(labels[1]).toBe('Work');
    expect(labels[2]).toMatch(/^Leo's PC \(lent\) · 2h 1\dm left$/);
    await click(item("Leo's PC"));
    expect(onStart).toHaveBeenCalledWith('claude', 'lend:g1');
    expect(onClose).toHaveBeenCalled();
  });

  it('the default sign-in still starts the chat with no account', async () => {
    const { onStart } = await mount(true);
    await click(item('Claude'));
    await click(item('Default sign-in'));
    expect(onStart).toHaveBeenCalledWith('claude');
  });

  it('a chat starts at once when nothing is borrowed (no extra step)', async () => {
    const { onStart } = await mount(false);
    await click(item('Claude'));
    expect(onStart).toHaveBeenCalledWith('claude');
  });
});
