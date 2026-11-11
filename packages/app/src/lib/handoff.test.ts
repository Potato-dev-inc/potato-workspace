import { describe, expect, it, vi } from 'vitest';
import type { AcpChatState } from './acpChat';
import { fileWritePrompt, handoffLabel, runHandoff, type HandoffDeps, type HandoffFileStat, type HandoffPane, type HandoffStatus } from './handoff';

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
    // Only appendNotes is used by this mode; the rest of the new-agent way must stay untouched.
    quick: {
      stamp: vi.fn(() => '20261111-0930'),
      prepare: vi.fn(async () => ({ stamp: '20261111-0930', path: 'C:/shop/.potato/handoffs/handoff-20261111-0930.md' })),
      appendNotes: vi.fn(async () => undefined),
      archive: vi.fn(async () => 'D:/data/handoffs/shop/x.md'),
      account: vi.fn(async () => 'acct-1'),
    },
  };
  return { deps, pane };
}

const mocked = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

const run = async (deps: HandoffDeps, fixedNotes = '') => {
  const seen: HandoffStatus[] = [];
  const final = await runHandoff('p1', deps, (s) => seen.push(s), { mode: 'file', fixedNotes });
  return { final, seen };
};

const untouched = (deps: HandoffDeps) => {
  expect(deps.startTerminal).not.toHaveBeenCalled();
  expect(deps.startChat).not.toHaveBeenCalled();
  expect(deps.startTerminalChat).not.toHaveBeenCalled();
  expect(deps.quick.prepare).not.toHaveBeenCalled();
  expect(deps.quick.archive).not.toHaveBeenCalled();
};

describe('Quick handoff (mode "file")', () => {
  it('asks for HANDOFF.md with both parts, waits for the turn, and reports it saved without opening any agent', async () => {
    const { deps } = world();
    const { final, seen } = await run(deps);
    expect(deps.send).toHaveBeenCalledTimes(1);
    expect(deps.send).toHaveBeenCalledWith('p1', fileWritePrompt());
    const prompt = mocked(deps.send).mock.calls[0][1] as string;
    expect(prompt).toContain('HANDOFF.md');
    expect(prompt).toContain('## Part 1: The task');
    expect(prompt).toContain('## Part 2: How this person works');
    expect(prompt).not.toContain('.potato');
    expect(deps.stat).toHaveBeenCalledWith('p1');
    untouched(deps);
    expect(seen.map((s) => s.kind)).toEqual(['writing', 'saved']);
    expect(final).toEqual({ kind: 'saved', paneId: 'p1', text: 'HANDOFF.md saved' });
  });

  it('adds the fixed notes to HANDOFF.md itself (no stamp), only when there are some', async () => {
    const a = world();
    await run(a.deps, 'Reply short.');
    expect(a.deps.quick.appendNotes).toHaveBeenCalledWith('p1', undefined, 'Reply short.');
    const b = world();
    await run(b.deps, '  ');
    expect(b.deps.quick.appendNotes).not.toHaveBeenCalled();
  });

  it('says so, and where, when the notes cannot be added', async () => {
    const { deps } = world();
    mocked(deps.quick.appendNotes).mockRejectedValue(new Error('Disk full'));
    const { final } = await run(deps, 'x');
    expect(final.kind).toBe('failed');
    expect(final.text).toBe('HANDOFF.md is written, but your fixed notes could not be added: Disk full');
  });

  it('fails in plain words when the agent finished but wrote no file', async () => {
    const { deps } = world({ stats: [missing, missing] });
    expect((await run(deps)).final).toEqual({ kind: 'failed', text: "The agent finished but HANDOFF.md wasn't written." });
    untouched(deps);
  });

  it('fails when an existing HANDOFF.md was not touched, and accepts one that changed', async () => {
    const same = world({ stats: [written, written] });
    expect((await run(same.deps)).final.text).toMatch(/wasn't updated/);
    const changed = world({ stats: [written, { ...written, modifiedMs: 9 }] });
    expect((await run(changed.deps)).final.kind).toBe('saved');
  });

  it('refuses while the agent is working or waiting for the person, without sending anything', async () => {
    const busy = world({ pane: { status: 'running' } });
    expect((await run(busy.deps)).final.text).toMatch(/still working/);
    const waiting = world({ pane: { status: 'waiting_input' } });
    expect((await run(waiting.deps)).final.text).toMatch(/waiting for you/);
    expect(busy.deps.send).not.toHaveBeenCalled();
    expect(waiting.deps.send).not.toHaveBeenCalled();
  });

  it('says so when the agent never starts the turn, and when the pane is closed', async () => {
    const never = world({ busyPolls: 0 });
    expect((await run(never.deps)).final.text).toMatch(/didn't start/);
    const { deps } = world();
    let calls = 0;
    mocked(deps.pane).mockImplementation(() => (++calls > 3 ? undefined : { id: 'p1', agentType: 'agentx', cwd: 'C:/shop', status: 'idle' }));
    expect((await run(deps)).final.text).toMatch(/closed/);
  });

  it('works the same for a chat, and opens nothing', async () => {
    const { deps } = world({ pane: { lane: 'acp' } });
    expect((await run(deps)).final.kind).toBe('saved');
    untouched(deps);
    expect(deps.select).not.toHaveBeenCalled();
  });

  it('the button label follows the mode', () => {
    expect(handoffLabel('file')).toBe('Quick handoff');
    expect(handoffLabel('new_agent')).toBe('Hand off to new agent');
  });
});
