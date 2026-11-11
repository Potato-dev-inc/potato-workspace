// Handoff to new agent, with fakes: the old agent writes a temporary note, the app adds the fixed notes, a new agent of the
// same kind (same model and sign-in where known) reads it and says only "Ready", then the note is moved out of the
// project. Quick handoff (HANDOFF.md only) is covered in handoff.test.ts.
import { describe, expect, it, vi } from 'vitest';
import type { AcpChatState } from './acpChat';
import { MODEL_UNKNOWN_NOTE, handoffStamp, quickStartPrompt, quickWritePrompt, runHandoff, type HandoffDeps, type HandoffFileStat, type HandoffPane, type HandoffStatus } from './handoff';

const PATH = 'C:/shop/.potato/handoffs/handoff-20261111-0930.md';
const modelOption = (current: string) => ({
  id: 'model',
  name: 'Model',
  category: 'model',
  type: 'select',
  currentValue: current,
  options: [
    { value: 'big', name: 'Big' },
    { value: 'small', name: 'Small' },
  ],
});
const chatState = (over: Partial<AcpChatState> = {}): AcpChatState =>
  ({
    lane: 'acp', agent: 'a1', label: 'A', phase: 'idle', status: 'idle', turnInFlight: false, stopping: false, canSteer: false, turn: 0,
    title: null, usage: null, permissions: [], closed: false, configOptions: [modelOption('big')], ...over,
  }) as AcpChatState;

const missing: HandoffFileStat = { exists: false, modifiedMs: 0, bytes: 0 };
const written: HandoffFileStat = { exists: true, modifiedMs: 5, bytes: 100 };

/**
 * Each agent is busy for a few polls after it gets a message, then idle. `p1` is the old pane; `n1` the new one.
 * Terminal panes read their status from `pane()`, chats from `chatState()`.
 */
function world(opts: { pane?: Partial<HandoffPane>; stats?: HandoffFileStat[]; newBusyPolls?: number; newChatModel?: string; noChatModel?: boolean; account?: string | null } = {}) {
  const pane: HandoffPane = { id: 'p1', agentType: 'agentx', cwd: 'C:/shop', lane: undefined, status: 'idle', ...opts.pane };
  const stats = [...(opts.stats ?? [missing, written])];
  const busy: Record<string, number> = { p1: 0, n1: 0 };
  const sentTo: Record<string, string[]> = { p1: [], n1: [] };
  let clock = 0;
  const isChat = pane.lane === 'acp';
  const options = (current: string) => (opts.noChatModel ? [] : [modelOption(current)]);
  const deps: HandoffDeps = {
    pane: vi.fn((id: string) => (isChat ? pane : { ...pane, id, status: (busy[id] ?? 0) > 0 ? 'running' : 'idle' })),
    chatState: vi.fn(async (id: string) =>
      id === 'p1'
        ? chatState({ turnInFlight: busy.p1 > 0, configOptions: options('big') })
        : chatState({ turnInFlight: busy.n1 > 0, configOptions: options(opts.newChatModel ?? 'small') }),
    ),
    send: vi.fn(async (id: string, text: string) => {
      sentTo[id].push(text);
      busy[id] = id === 'p1' ? 2 : (opts.newBusyPolls ?? 2);
    }),
    stat: vi.fn(async () => stats.shift() ?? written),
    startTerminal: vi.fn(async () => 'n1'),
    startChat: vi.fn(async () => 'n1'),
    startTerminalChat: vi.fn(async () => 'n1'),
    setConfig: vi.fn(async () => undefined),
    select: vi.fn(),
    titleOf: vi.fn(() => 'Agent X two'),
    sleep: vi.fn(async (ms: number) => {
      clock += ms;
      for (const id of Object.keys(busy)) if (busy[id] > 0) busy[id] -= 1;
    }),
    now: () => clock,
    quick: {
      stamp: vi.fn(() => '20261111-0930'),
      prepare: vi.fn(async (_id: string, stamp: string) => ({ stamp, path: PATH })),
      appendNotes: vi.fn(async () => undefined),
      archive: vi.fn(async () => 'D:/data/handoffs/shop-1/handoff-20261111-0930.md'),
      account: vi.fn(async () => (opts.account === undefined ? 'acct-1' : opts.account)),
    },
  };
  return { deps, sentTo };
}

const mocked = (fn: unknown) => fn as ReturnType<typeof vi.fn>;
const run = async (deps: HandoffDeps, fixedNotes = '') => {
  const seen: HandoffStatus[] = [];
  const final = await runHandoff('p1', deps, (s) => seen.push(s), { mode: 'new_agent', fixedNotes });
  return { final, seen };
};

describe('the prompts', () => {
  it('the writing prompt names the exact file and asks for both parts', () => {
    const prompt = quickWritePrompt(PATH);
    expect(prompt).toContain(PATH);
    expect(prompt).toContain('## Part 1: The task');
    expect(prompt).toContain('## Part 2: How this person works');
    for (const word of ['goal', 'what is done', 'what is left', 'key files', 'decisions', 'verify', 'gotchas']) expect(prompt.toLowerCase()).toContain(word);
    for (const word of ['subagents', 'plan or approval', 'commit and push', 'testing and verification', 'short or detailed', 'never to do', 'Do not guess']) expect(prompt).toContain(word);
    expect(prompt).toMatch(/reply with one line[^]*do nothing else/);
  });

  it('the start prompt gives the exact path and asks for only "Ready"', () => {
    const prompt = quickStartPrompt(PATH);
    expect(prompt).toContain(PATH);
    expect(prompt).toMatch(/only the word "Ready"/);
    expect(prompt).toMatch(/no other work and make no plan/i);
  });

  it('the file name stamp is local time, YYYYMMDD-HHMM', () => {
    expect(handoffStamp(new Date(2026, 10, 11, 9, 5))).toBe('20261111-0905');
  });
});

describe('handoff to new agent (terminal pane)', () => {
  it('writes the temporary file, opens the same agent, asks for "Ready", then moves the file', async () => {
    const { deps, sentTo } = world();
    const { final, seen } = await run(deps);
    expect(deps.quick.prepare).toHaveBeenCalledWith('p1', '20261111-0930');
    expect(sentTo.p1).toEqual([quickWritePrompt(PATH)]);
    expect(deps.stat).toHaveBeenCalledWith('p1', '20261111-0930');
    expect(deps.startTerminal).toHaveBeenCalledWith('agentx', 'C:/shop', 'acct-1');
    expect(sentTo.n1).toEqual([quickStartPrompt(PATH)]);
    expect(deps.quick.archive).toHaveBeenCalledWith('p1', '20261111-0930');
    // The file is moved only after the new agent has been messaged and its turn is over.
    expect(mocked(deps.quick.archive).mock.invocationCallOrder[0]).toBeGreaterThan(mocked(deps.send).mock.invocationCallOrder[1]);
    expect(seen.map((s) => s.kind)).toEqual(['writing', 'opening', 'opening', 'done']);
    expect(final).toEqual({ kind: 'done', newPaneId: 'n1', text: `Opened Agent X two. ${MODEL_UNKNOWN_NOTE}` });
  });

  it('does not use HANDOFF.md or the old prompts', async () => {
    const { deps, sentTo } = world();
    await run(deps);
    expect(sentTo.n1.join('\n')).not.toMatch(/Before you change anything/);
    expect(mocked(deps.stat).mock.calls.every((c) => c[1] === '20261111-0930')).toBe(true);
  });

  it('adds the fixed notes after the file is written and before the new agent opens', async () => {
    const { deps } = world();
    await run(deps, 'Reply short.\nNever push.');
    expect(deps.quick.appendNotes).toHaveBeenCalledWith('p1', '20261111-0930', 'Reply short.\nNever push.');
    const appended = mocked(deps.quick.appendNotes).mock.invocationCallOrder[0];
    expect(appended).toBeGreaterThan(mocked(deps.stat).mock.invocationCallOrder[1]);
    expect(appended).toBeLessThan(mocked(deps.startTerminal).mock.invocationCallOrder[0]);
  });

  it('does not touch the file when there are no fixed notes', async () => {
    const { deps } = world();
    await run(deps, '   ');
    expect(deps.quick.appendNotes).not.toHaveBeenCalled();
  });

  it('opens the new agent with no sign-in when the app does not know the old one', async () => {
    const { deps } = world({ account: null });
    await run(deps);
    expect(deps.startTerminal).toHaveBeenCalledWith('agentx', 'C:/shop');
  });

  it('opens the new agent without a sign-in when looking it up fails', async () => {
    const { deps } = world();
    mocked(deps.quick.account).mockRejectedValue(new Error('x'));
    expect((await run(deps)).final.kind).toBe('done');
    expect(deps.startTerminal).toHaveBeenCalledWith('agentx', 'C:/shop');
  });
});

describe('handoff to new agent (chat)', () => {
  it('passes the same model and the same sign-in', async () => {
    const { deps, sentTo } = world({ pane: { lane: 'acp' }, newChatModel: 'small' });
    const { final } = await run(deps);
    expect(deps.startChat).toHaveBeenCalledWith('agentx', 'C:/shop', 'acct-1');
    expect(deps.select).toHaveBeenCalledWith('n1');
    expect(deps.setConfig).toHaveBeenCalledWith('n1', 'model', 'big');
    expect(sentTo.n1).toEqual([quickStartPrompt(PATH)]);
    expect(final.text).toBe('Opened Agent X two (Big)');
    expect(deps.quick.archive).toHaveBeenCalledTimes(1);
  });

  it('a chat that lists no model gets the same note as a terminal', async () => {
    const { deps } = world({ pane: { lane: 'acp' }, noChatModel: true });
    const { final } = await run(deps);
    expect(final.text).toContain(MODEL_UNKNOWN_NOTE);
  });
});

describe('handoff to new agent (terminal chat)', () => {
  it('starts a terminal chat with the same sign-in', async () => {
    const { deps } = world({ pane: { lane: 'terminal_chat' } });
    await run(deps);
    expect(deps.startTerminalChat).toHaveBeenCalledWith('agentx', 'C:/shop', 'acct-1');
    expect(deps.select).toHaveBeenCalledWith('n1');
  });
});

describe('handoff to new agent, when something goes wrong', () => {
  it('stops when the file cannot be prepared, sending nothing', async () => {
    const { deps } = world();
    mocked(deps.quick.prepare).mockRejectedValue(new Error('Read-only folder'));
    const { final } = await run(deps);
    expect(final).toEqual({ kind: 'failed', text: 'Could not get the handoff file ready: Read-only folder' });
    expect(deps.send).not.toHaveBeenCalled();
  });

  it('fails, with the path, when the agent finished but wrote nothing', async () => {
    const { deps } = world({ stats: [missing, missing] });
    const { final } = await run(deps);
    expect(final.kind).toBe('failed');
    expect(final.text).toContain(PATH);
    expect(deps.startTerminal).not.toHaveBeenCalled();
    expect(deps.quick.archive).not.toHaveBeenCalled();
  });

  it('fails when the file is empty', async () => {
    const { deps } = world({ stats: [missing, { exists: true, modifiedMs: 1, bytes: 0 }] });
    expect((await run(deps)).final.kind).toBe('failed');
  });

  it('refuses while the agent is busy, before preparing anything', async () => {
    const { deps } = world();
    mocked(deps.pane).mockReturnValue({ id: 'p1', agentType: 'agentx', cwd: 'C:/shop', status: 'running' });
    expect((await run(deps)).final.text).toMatch(/still working/);
    expect(deps.quick.prepare).not.toHaveBeenCalled();
  });

  it('says so when the old agent never starts on it', async () => {
    const { deps } = world();
    mocked(deps.send).mockImplementation(async () => undefined);
    expect((await run(deps)).final.text).toMatch(/didn't start/);
    expect(deps.startTerminal).not.toHaveBeenCalled();
  });

  it('keeps the file and says where it is when the fixed notes cannot be added, and opens nothing', async () => {
    const { deps } = world();
    mocked(deps.quick.appendNotes).mockRejectedValue(new Error('Disk full'));
    const { final } = await run(deps, 'note');
    expect(final.kind).toBe('failed');
    expect(final.text).toContain('Disk full');
    expect(final.text).toContain(PATH);
    expect(deps.startTerminal).not.toHaveBeenCalled();
  });

  it('keeps the file when the new agent cannot start or cannot be messaged', async () => {
    const a = world();
    mocked(a.deps.startTerminal).mockRejectedValue(new Error('No login'));
    expect((await run(a.deps)).final.text).toBe(`The handoff is written, but the new agent didn't start: No login. The file is at ${PATH}`);
    const b = world();
    const real = mocked(b.deps.send).getMockImplementation()!;
    mocked(b.deps.send).mockImplementation(async (id: string, text: string) => {
      if (id === 'n1') throw new Error('Pane closed');
      return real(id, text);
    });
    expect((await run(b.deps)).final.text).toContain(PATH);
    expect(a.deps.quick.archive).not.toHaveBeenCalled();
    expect(b.deps.quick.archive).not.toHaveBeenCalled();
  });

  it('leaves the file in the project, and says where, when the move fails', async () => {
    const { deps } = world();
    mocked(deps.quick.archive).mockRejectedValue(new Error('Access denied'));
    const { final } = await run(deps);
    expect(final.kind).toBe('done');
    expect(final.text).toContain('Access denied');
    expect(final.text).toContain(PATH);
  });

  it('does not move the file when the new agent never replies', async () => {
    const { deps } = world({ newBusyPolls: 0 });
    const { final } = await run(deps);
    expect(final.kind).toBe('done');
    expect(final.text).toContain(PATH);
    expect(deps.quick.archive).not.toHaveBeenCalled();
  });

  it('does not move the file when the new agent stops to ask something', async () => {
    const { deps } = world();
    const original = mocked(deps.pane).getMockImplementation()!;
    mocked(deps.pane).mockImplementation((id: string) => (id === 'n1' ? { id, agentType: 'agentx', cwd: 'C:/shop', status: 'waiting_input' } : original(id)));
    const { final } = await run(deps);
    expect(final.text).toContain(PATH);
    expect(deps.quick.archive).not.toHaveBeenCalled();
  });
});
