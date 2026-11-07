// @vitest-environment jsdom
// The "+" menu with chat sessions: ONE Chat | Terminal switch at the top (no switch on the rows). Chat starts a chat for an
// agent that has one, Terminal starts as before; a failed chat start says why and, when the terminal can run the agent,
// offers "Start in terminal". Without the `chat` prop the menu is the old plain one. (The whole screen, with the switch's
// saving and the "no chat yet" prompt, is tested in NewAgentMenu.screen.test.tsx.)
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcpLaneAgent } from '../../lib/acpChat';
import type { AccountsApi } from '../../lib/accounts';
import type { PickApi } from '../../lib/pick-for-me';
import { NewAgentMenu } from './NewAgentMenu';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ENTRIES = [
  { type: 'other', label: 'Other' },
  { type: 'fakeagent', label: 'Fake agent' },
];
const accounts = { list: async () => ({ agents: [], accounts: [] }) } as unknown as AccountsApi;
const agent = (over: Partial<AcpLaneAgent> = {}): AcpLaneAgent => ({
  id: 'fakeagent',
  label: 'Fake agent',
  lane: 'terminal',
  effective_lane: 'terminal',
  disabled: false,
  disabled_note: null,
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

async function mount(chat: { agents: AcpLaneAgent[]; onStart: (id: string) => Promise<void>; mode?: 'chat' | 'terminal' } | undefined) {
  const onStart = vi.fn();
  const onClose = vi.fn();
  const onMode = vi.fn();
  await act(async () => {
    root.render(
      <NewAgentMenu
        entries={ENTRIES}
        readyAgents={new Set()}
        onStart={onStart}
        onClose={onClose}
        accountsApi={accounts}
        chat={chat ? { mode: chat.mode ?? 'chat', onMode, agents: chat.agents, onStart: chat.onStart } : undefined}
      />,
    );
  });
  return { onStart, onClose, onMode };
}

const main = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button.ck-menu-item')].find((b) => b.textContent?.includes(label))!;
const seg = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('[data-testid="start-mode"] .ck-lane-seg-btn')].find((b) => b.textContent === label)!;

describe('NewAgentMenu with chat sessions', () => {
  it('draws no switch without the chat prop, and the agent starts as before', async () => {
    const { onStart, onClose } = await mount(undefined);
    expect(host.querySelector('.ck-lane-seg')).toBeNull();
    await act(async () => main('Fake agent').click());
    expect(onStart).toHaveBeenCalledWith('fakeagent', undefined);
    expect(onClose).toHaveBeenCalled();
  });

  it('draws one switch at the top and none on a row', async () => {
    await mount({ agents: [agent()], onStart: vi.fn(async () => undefined) });
    expect(host.querySelectorAll('.ck-lane-seg')).toHaveLength(1);
    expect(host.querySelector('[data-testid^="lane-row-"]')).toBeNull();
    expect(seg('Chat').getAttribute('aria-pressed')).toBe('true');
    expect(seg('Terminal').getAttribute('aria-pressed')).toBe('false');
  });

  it('the switch asks the host to save the mode and starts nothing by itself', async () => {
    const chatStart = vi.fn(async () => undefined);
    const { onStart, onMode } = await mount({ agents: [agent()], onStart: chatStart });
    await act(async () => seg('Terminal').click());
    expect(onMode).toHaveBeenCalledWith('terminal');
    expect(chatStart).not.toHaveBeenCalled();
    expect(onStart).not.toHaveBeenCalled();
  });

  it('on Chat a click starts the chat and closes the menu', async () => {
    const chatStart = vi.fn(async () => undefined);
    const { onStart, onClose } = await mount({ agents: [agent()], onStart: chatStart });
    await act(async () => main('Fake agent').click());
    expect(chatStart).toHaveBeenCalledWith('fakeagent');
    expect(onStart).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('on Terminal a click starts the terminal', async () => {
    const chatStart = vi.fn(async () => undefined);
    const { onStart } = await mount({ agents: [agent({ lane: 'acp', effective_lane: 'acp' })], onStart: chatStart, mode: 'terminal' });
    await act(async () => main('Fake agent').click());
    expect(onStart).toHaveBeenCalledWith('fakeagent', undefined);
    expect(chatStart).not.toHaveBeenCalled();
  });

  it('a failed chat start says why and offers the terminal when it can run the agent', async () => {
    const chatStart = vi.fn(async () => {
      throw 'ACP_ADAPTER_MISSING: The chat could not start. The terminal can run this agent instead.';
    });
    const { onStart, onClose } = await mount({ agents: [agent()], onStart: chatStart });
    await act(async () => main('Fake agent').click());
    expect(onClose).not.toHaveBeenCalled();
    const fail = host.querySelector('[data-testid="chat-start-failed"]')!;
    expect(fail.textContent).toContain('The chat could not start. The terminal can run this agent instead.');
    expect(fail.textContent).not.toContain('ACP_ADAPTER_MISSING');
    const fallback = [...fail.querySelectorAll('button')].find((b) => b.textContent === 'Start in terminal')!;
    await act(async () => fallback.click());
    expect(onStart).toHaveBeenCalledWith('fakeagent', undefined);
    expect(onClose).toHaveBeenCalled();
  });

  it('a failed start with no terminal fallback only says why', async () => {
    const chatStart = vi.fn(async () => {
      throw new Error('Pick a project folder first.');
    });
    await mount({ agents: [agent()], onStart: chatStart });
    await act(async () => main('Fake agent').click());
    const fail = host.querySelector('[data-testid="chat-start-failed"]')!;
    expect(fail.textContent).toBe('Pick a project folder first.');
    expect(fail.querySelector('button')).toBeNull();
  });

  describe('"Pick for me" follows the switch', () => {
    const picked: PickApi = {
      pick: async () => ({
        choice: { agentId: 'fakeagent', accountId: null, label: 'Fake agent' },
        reason: 'It did best here.',
        basis: 'clear',
        metric: 'checks_green',
        sample: 'steady',
        considered: [],
        notes: [],
      }),
    } as unknown as PickApi;
    async function mountPick(mode: 'chat' | 'terminal', chatStart: (id: string) => Promise<void>) {
      const onStart = vi.fn();
      const onClose = vi.fn();
      await act(async () => {
        root.render(
          <NewAgentMenu
            entries={ENTRIES}
            readyAgents={new Set()}
            onStart={onStart}
            onClose={onClose}
            accountsApi={accounts}
            pick={picked}
            project={{ path: 'C:\proj', name: 'proj', state: 'repo' }}
            chat={{ mode, onMode: vi.fn(), agents: [agent()], onStart: chatStart }}
          />,
        );
      });
      await act(async () => main('Pick for me').click());
      return { onStart, onClose };
    }

    it('on Chat its Start button starts the chat', async () => {
      const chatStart = vi.fn(async () => undefined);
      const { onStart } = await mountPick('chat', chatStart);
      await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Start'))!.click());
      expect(chatStart).toHaveBeenCalledWith('fakeagent');
      expect(onStart).not.toHaveBeenCalled();
    });

    it('on Terminal its Start button starts the terminal', async () => {
      const chatStart = vi.fn(async () => undefined);
      const { onStart } = await mountPick('terminal', chatStart);
      await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Start'))!.click());
      expect(onStart).toHaveBeenCalledWith('fakeagent', null);
      expect(chatStart).not.toHaveBeenCalled();
    });
  });
});
