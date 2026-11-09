import { describe, expect, it, vi } from 'vitest';
import type { AcpChatState } from './acpChat';
import { HANDOFF_START_PROMPT, HANDOFF_WRITE_PROMPT, runHandoff, type HandoffDeps, type HandoffFileStat, type HandoffPane, type HandoffStatus } from './handoff';

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
    lane: 'acp',
    agent: 'a1',
    label: 'A',
    phase: 'idle',
    status: 'idle',
    turnInFlight: false,
    stopping: false,
    canSteer: false,
    turn: 0,
    title: null,
    usage: null,
    permissions: [],
    closed: false,
    configOptions: [modelOption('big')],
    ...over,
  }) as AcpChatState;

const missing: HandoffFileStat = { exists: false, modifiedMs: 0, bytes: 0 };
const written: HandoffFileStat = { exists: true, modifiedMs: 5, bytes: 100 };

/** A world where the old pane is busy for `busyPolls` polls after the message is sent, then idle. */
function world(opts: { pane?: Partial<HandoffPane>; stats?: HandoffFileStat[]; busyPolls?: number; newChatModel?: string } = {}) {
  const pane: HandoffPane = { id: 'p1', agentType: 'agentx', cwd: 'C:/shop', lane: undefined, status: 'idle', ...opts.pane };
  const stats = [...(opts.stats ?? [missing, written])];
  let sent = false;
  let busyLeft = opts.busyPolls ?? 2;
  let clock = 0;
  const deps: HandoffDeps = {
    pane: vi.fn(() => {
      // Terminal pane: its status follows the fake turn.
      if (pane.lane !== 'acp' && sent) return { ...pane, status: busyLeft > 0 ? 'running' : 'idle' };
      return pane;
    }),
    chatState: vi.fn(async (id: string) => {
      if (id !== 'p1') return chatState({ configOptions: [modelOption(opts.newChatModel ?? 'small')] });
      return chatState({ turnInFlight: sent && busyLeft > 0 });
    }),
    send: vi.fn(async (id: string) => {
      if (id === 'p1') sent = true;
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
      if (sent && busyLeft > 0) busyLeft -= 1;
    }),
    now: () => clock,
  };
  return { deps, pane };
}

const mocked = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

const run = async (deps: HandoffDeps) => {
  const seen: HandoffStatus[] = [];
  const final = await runHandoff('p1', deps, (s) => seen.push(s));
  return { final, seen };
};

describe('runHandoff (terminal pane)', () => {
  it('asks for HANDOFF.md, waits for the turn, then opens a new agent of the same type in the same folder', async () => {
    const { deps } = world();
    const { final, seen } = await run(deps);
    expect(deps.send).toHaveBeenNthCalledWith(1, 'p1', HANDOFF_WRITE_PROMPT);
    expect(deps.startTerminal).toHaveBeenCalledWith('agentx', 'C:/shop');
    expect(deps.send).toHaveBeenNthCalledWith(2, 'n1', HANDOFF_START_PROMPT);
    expect(deps.setConfig).not.toHaveBeenCalled();
    expect(seen.map((s) => s.kind)).toEqual(['writing', 'opening', 'done']);
    expect(final).toEqual({ kind: 'done', newPaneId: 'n1', text: 'Opened Agent X two' });
  });

  it('fails in plain words when the agent finished but wrote no file, and opens nothing', async () => {
    const { deps } = world({ stats: [missing, missing] });
    const { final } = await run(deps);
    expect(final).toEqual({ kind: 'failed', text: "The agent finished but HANDOFF.md wasn't written." });
    expect(deps.startTerminal).not.toHaveBeenCalled();
    expect(deps.send).toHaveBeenCalledTimes(1);
  });

  it('fails when an existing HANDOFF.md was not touched', async () => {
    const { deps } = world({ stats: [written, written] });
    const { final } = await run(deps);
    expect(final.kind).toBe('failed');
    expect(final.text).toMatch(/wasn't updated/);
    expect(deps.startTerminal).not.toHaveBeenCalled();
  });

  it('accepts an existing HANDOFF.md that changed', async () => {
    const { deps } = world({ stats: [written, { ...written, modifiedMs: 9 }] });
    expect((await run(deps)).final.kind).toBe('done');
  });

  it('refuses while the agent is working or waiting for the person, without sending anything', async () => {
    const busy = world({ pane: { status: 'running' } });
    expect((await run(busy.deps)).final.text).toMatch(/still working/);
    const waiting = world({ pane: { status: 'waiting_input' } });
    expect((await run(waiting.deps)).final.text).toMatch(/waiting for you/);
    expect(busy.deps.send).not.toHaveBeenCalled();
    expect(waiting.deps.send).not.toHaveBeenCalled();
  });

  it('says so when the agent never starts the turn', async () => {
    const { deps } = world({ busyPolls: 0 });
    const { final } = await run(deps);
    expect(final.text).toMatch(/didn't start/);
    expect(deps.startTerminal).not.toHaveBeenCalled();
  });

  it('says why when the new agent cannot start, and why when its first message fails', async () => {
    const a = world();
    mocked(a.deps.startTerminal).mockRejectedValue(new Error('No login'));
    expect((await run(a.deps)).final.text).toBe("The handoff is written, but the new agent didn't start: No login");
    const b = world();
    mocked(b.deps.startTerminal).mockResolvedValue(null);
    expect((await run(b.deps)).final.text).toBe("The handoff is written, but the new agent didn't start.");
    const c = world();
    const realSend = mocked(c.deps.send).getMockImplementation()!;
    mocked(c.deps.send).mockImplementation(async (id: string, text: string) => {
      if (id === 'n1') throw new Error('Pane closed');
      return realSend(id, text);
    });
    expect((await run(c.deps)).final.text).toBe('The new agent opened, but its first message was not sent: Pane closed');
  });

  it('fails when the pane is closed during the turn', async () => {
    const { deps } = world();
    let calls = 0;
    mocked(deps.pane).mockImplementation(() => (++calls > 3 ? undefined : { id: 'p1', agentType: 'agentx', cwd: 'C:/shop', status: 'idle' }));
    expect((await run(deps)).final.text).toMatch(/closed/);
  });
});

describe('runHandoff (chat)', () => {
  it('starts a chat in the same folder, opens it, and passes the same model through', async () => {
    const { deps } = world({ pane: { lane: 'acp' }, newChatModel: 'small' });
    const { final } = await run(deps);
    expect(deps.startChat).toHaveBeenCalledWith('agentx', 'C:/shop');
    expect(deps.startTerminal).not.toHaveBeenCalled();
    expect(deps.select).toHaveBeenCalledWith('n1');
    expect(deps.setConfig).toHaveBeenCalledWith('n1', 'model', 'big');
    expect(final.text).toBe('Opened Agent X two (Big)');
    expect(deps.send).toHaveBeenLastCalledWith('n1', HANDOFF_START_PROMPT);
  });

  it('does not set the model when the new chat already has it', async () => {
    const { deps } = world({ pane: { lane: 'acp' }, newChatModel: 'big' });
    await run(deps);
    expect(deps.setConfig).not.toHaveBeenCalled();
  });

  it('keeps the default model, and says so, when the model cannot be set', async () => {
    const { deps } = world({ pane: { lane: 'acp' }, newChatModel: 'small' });
    mocked(deps.setConfig).mockRejectedValue(new Error('BUSY'));
    const { final } = await run(deps);
    expect(final.kind).toBe('done');
    expect(final.text).toBe('Opened Agent X two (the new agent kept its default model)');
  });

  it('sees a turn in flight through the chat state, and a permission wait as waiting', async () => {
    const busy = world({ pane: { lane: 'acp' } });
    mocked(busy.deps.chatState).mockResolvedValue(chatState({ turnInFlight: true }));
    expect((await run(busy.deps)).final.text).toMatch(/still working/);
    const ask = world({ pane: { lane: 'acp' } });
    mocked(ask.deps.chatState).mockResolvedValue(chatState({ status: 'waiting_input' }));
    expect((await run(ask.deps)).final.text).toMatch(/waiting for you/);
  });
});

describe('runHandoff (terminal chat)', () => {
  it('starts a terminal chat in the same folder and opens it', async () => {
    const { deps } = world({ pane: { lane: 'terminal_chat' } });
    await run(deps);
    expect(deps.startTerminalChat).toHaveBeenCalledWith('agentx', 'C:/shop');
    expect(deps.select).toHaveBeenCalledWith('n1');
  });
});
