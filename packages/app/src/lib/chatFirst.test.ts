import { describe, expect, it, vi } from 'vitest';
import type { AcpLaneView } from './acpChat';
import { canChat, chatAgentIds, offeredAgents, splitByChat, startChatFirst, type ChatFirstDeps } from './chatFirst';

const row = (id: string, disabled = false) => ({ id, label: id, lane: 'terminal' as const, effective_lane: 'terminal' as const, disabled, disabled_note: null });
const view = (over: Partial<AcpLaneView> = {}): AcpLaneView => ({ labs_enabled: true, agents: [row('claude'), row('codex'), row('kilo', true)], ...over });

describe('which agents can chat', () => {
  it('is the agents the backend lists with a chat that is not switched off, in any case', () => {
    expect([...chatAgentIds(view())].sort()).toEqual(['claude', 'codex']);
    expect(canChat(view(), 'Claude')).toBe(true);
    expect(canChat(view(), 'aider')).toBe(false);
    expect(canChat(view(), 'kilo')).toBe(false);
  });
  it('is nobody when Chat is off or nothing is known', () => {
    expect(chatAgentIds(view({ labs_enabled: false })).size).toBe(0);
    expect(chatAgentIds(null).size).toBe(0);
  });
});

describe('offeredAgents', () => {
  const entries = [{ type: 'claude' }, { type: 'aider' }, { type: 'kilo' }, { type: 'headless-only', disabled: true }, { type: 'bash', shell: true }];
  it('keeps the agents that can chat, counts the ones that need a terminal, and never offers a shell', () => {
    const { offered, needTerminals } = offeredAgents(entries, view());
    expect(offered.map((e) => e.type)).toEqual(['claude']);
    // aider and kilo (its chat is off). The headless-only agent cannot open a pane at all, and a shell is not an agent.
    expect(needTerminals).toBe(2);
  });
  it('hides nothing but the shells while the lanes are unknown', () => {
    const { offered, needTerminals } = offeredAgents(entries, null);
    expect(offered.map((e) => e.type)).toEqual(['claude', 'aider', 'kilo', 'headless-only']);
    expect(needTerminals).toBe(0);
    expect(splitByChat(entries, null).offered).toHaveLength(4);
  });
});

function deps(over: Partial<ChatFirstDeps> = {}): ChatFirstDeps {
  return { laneGet: async () => view(), startChat: vi.fn(async () => 'chat-1'), ...over };
}

describe('startChatFirst', () => {
  it('starts a chat in the folder, or in the default folder when none is named', async () => {
    const d = deps();
    expect(await startChatFirst({ agentId: 'claude', folder: '/work/a' }, d)).toEqual({ kind: 'started', paneId: 'chat-1' });
    expect(d.startChat).toHaveBeenCalledWith('claude', '/work/a');
    await startChatFirst({ agentId: 'claude' }, d);
    expect(d.startChat).toHaveBeenLastCalledWith('claude', '');
  });
  it('passes the sign-in and sets the model once the chat is there', async () => {
    const setModel = vi.fn(async () => null);
    const d = deps({ setModel });
    await startChatFirst({ agentId: 'codex', accountId: 'acc1', folder: '/w', model: 'gpt-x' }, d);
    expect(d.startChat).toHaveBeenCalledWith('codex', '/w', 'acc1');
    expect(setModel).toHaveBeenCalledWith('chat-1', 'gpt-x');
  });
  it('says "no chat" for an agent that cannot chat, or when the lanes cannot be read, so the caller keeps what it did before', async () => {
    const d = deps();
    expect(await startChatFirst({ agentId: 'aider' }, d)).toEqual({ kind: 'no-chat' });
    expect(d.startChat).not.toHaveBeenCalled();
    expect(await startChatFirst({ agentId: 'claude' }, deps({ laneGet: async () => Promise.reject(new Error('no shell')) }))).toEqual({ kind: 'no-chat' });
  });
  it('a failed start is one plain sentence, never a throw; a missing add-on points at Settings', async () => {
    const failed = await startChatFirst({ agentId: 'claude' }, deps({ startChat: async () => Promise.reject(new Error('ACP_START_FAILED: The agent did not answer.')) }));
    expect(failed.kind).toBe('failed');
    const addon = await startChatFirst({ agentId: 'claude' }, deps({ startChat: async () => Promise.reject(new Error('ACP_ADDON_MISSING: not installed')) }));
    expect(addon).toEqual({ kind: 'failed', sentence: expect.stringContaining('add-on') });
  });
});
