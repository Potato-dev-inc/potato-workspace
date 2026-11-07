// @vitest-environment jsdom
// The "+" menu and Chat (terminal): an agent whose saved way to run is Chat (terminal) starts through `onStartTerminal`
// when the menu's switch is on Chat, and never through the ACP start. A failed start says why, with no "Start in
// terminal" button, because a Chat (terminal) pane already is a terminal. There is no per-row switch any more.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalChatAgent } from '../../lib/acpChat';
import type { AccountsApi } from '../../lib/accounts';
import { NewAgentMenu } from './NewAgentMenu';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ENTRIES = [
  { type: 'fakeagent', label: 'Fake agent' },
  { type: 'other', label: 'Other' },
];
const accounts = { list: async () => ({ agents: [], accounts: [] }) } as unknown as AccountsApi;
const tc = (over: Partial<TerminalChatAgent> = {}): TerminalChatAgent => ({
  id: 'fakeagent',
  label: 'Fake agent',
  reads_file: true,
  can_resume: false,
  can_answer_prompts: false,
  note: 'It cannot resume old sessions.',
  chosen: false,
  ...over,
});

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

async function mount(terminalChat: TerminalChatAgent[], onStartTerminal: (id: string) => Promise<void>, mode: 'chat' | 'terminal' = 'chat') {
  const onStart = vi.fn();
  const onClose = vi.fn();
  const chatStart = vi.fn(async () => undefined);
  await act(async () => {
    root.render(
      <NewAgentMenu
        entries={ENTRIES}
        readyAgents={new Set()}
        onStart={onStart}
        onClose={onClose}
        accountsApi={accounts}
        chat={{ mode, onMode: vi.fn(), agents: [], onStart: chatStart, terminalChat, onStartTerminal }}
      />,
    );
  });
  return { onStart, onClose, chatStart };
}
const main = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button.ck-menu-item')].find((b) => b.textContent?.includes(label))!;

describe('NewAgentMenu and Chat (terminal)', () => {
  it('draws no per-row switch and no ACP word', async () => {
    await mount([tc({ chosen: true })], vi.fn());
    expect(host.querySelector('[data-testid="lane-row-fakeagent"]')).toBeNull();
    expect(host.textContent).not.toContain('ACP');
  });

  it('with the switch on Chat, an agent saved as Chat (terminal) starts through onStartTerminal, and nothing else', async () => {
    const startTerminal = vi.fn(async () => undefined);
    const { onStart, onClose, chatStart } = await mount([tc({ chosen: true })], startTerminal);
    await act(async () => main('Fake agent').click());
    expect(startTerminal).toHaveBeenCalledWith('fakeagent');
    expect(chatStart).not.toHaveBeenCalled();
    expect(onStart).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('an agent that can run as Chat (terminal) but is not saved that way starts a plain terminal', async () => {
    const startTerminal = vi.fn(async () => undefined);
    const { onStart } = await mount([tc()], startTerminal);
    await act(async () => main('Fake agent').click());
    expect(onStart).toHaveBeenCalledWith('fakeagent', undefined);
    expect(startTerminal).not.toHaveBeenCalled();
  });

  it('with the switch on Terminal it starts a plain terminal even when saved as Chat (terminal)', async () => {
    const startTerminal = vi.fn(async () => undefined);
    const { onStart } = await mount([tc({ chosen: true })], startTerminal, 'terminal');
    await act(async () => main('Fake agent').click());
    expect(onStart).toHaveBeenCalledWith('fakeagent', undefined);
    expect(startTerminal).not.toHaveBeenCalled();
  });

  it('a failed Chat (terminal) start says why and offers no terminal fallback', async () => {
    const startTerminal = vi.fn(async () => {
      throw 'NOT_AVAILABLE: This agent cannot run as a chat in a terminal.';
    });
    const { onClose } = await mount([tc({ chosen: true })], startTerminal);
    await act(async () => main('Fake agent').click());
    expect(onClose).not.toHaveBeenCalled();
    const fail = host.querySelector('[data-testid="chat-start-failed"]')!;
    expect(fail.textContent).toContain('cannot run as a chat in a terminal');
    expect(fail.querySelector('button')).toBeNull();
  });
});
