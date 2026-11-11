// Warming during the first screen: starts the same pool Settings > Preload drives, never overrides it.
import { describe, expect, it, vi } from 'vitest';
import { startWarming, waitForWarm, warmState, type WarmApi } from './warm';

const config = (preload: { enabled: boolean; providers: Record<string, number> }) =>
  ({ config: { preload, enabled: false, backends: {}, max_total: 3, recent_projects: 2, recent_hours: 6, idle_timeout_secs: 1200 } }) as never;

const api = (status: unknown, warmable = ['claude', 'codex']): WarmApi => ({
  status: vi.fn(async () => status as never),
  setConfig: vi.fn(async () => null),
  setProject: vi.fn(async () => true),
  warmable: () => warmable,
});

describe('startWarming', () => {
  it('turns Preload on for the wanted agents that have a warm mode, then follows the folder', async () => {
    const a = api(config({ enabled: false, providers: {} }));
    expect(await startWarming(a, ['claude', 'codex', 'cursor_agent'], 'D:/p')).toBe('started');
    const sent = (a.setConfig as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sent.preload).toEqual({ enabled: true, providers: { claude: 1, codex: 1 } });
    expect(a.setProject).toHaveBeenCalledWith('D:/p');
  });
  it('keeps a Preload the person already set up', async () => {
    const a = api(config({ enabled: true, providers: { codex: 2 } }));
    expect(await startWarming(a, ['claude'], 'D:/p')).toBe('kept');
    expect(a.setConfig).not.toHaveBeenCalled();
    expect(a.setProject).toHaveBeenCalledWith('D:/p');
  });
  it('does nothing for agents without a warm mode, and with no folder only turns the pool on', async () => {
    const none = api(config({ enabled: false, providers: {} }), []);
    expect(await startWarming(none, ['claude'], 'D:/p')).toBe('nothing');
    expect(none.setConfig).not.toHaveBeenCalled();
    const noFolder = api(config({ enabled: false, providers: {} }));
    expect(await startWarming(noFolder, ['claude'], null)).toBe('started');
    expect(noFolder.setProject).not.toHaveBeenCalled();
  });
  it('never throws: warming is a convenience', async () => {
    const broken = api(null);
    expect(await startWarming(broken, ['claude'], 'D:/p')).toBe('nothing');
    const throws = { ...api(config({ enabled: false, providers: {} })), setConfig: vi.fn(async () => { throw new Error('no pool'); }) } as WarmApi;
    expect(await startWarming(throws, ['claude'], 'D:/p')).toBe('nothing');
  });
});

describe('warmState and waitForWarm', () => {
  const sb = (state: string, over: Record<string, unknown> = {}) => ({ agent_type: 'claude', project: 'D:/p/', headless: false, state, ...over });
  it('matches the folder however it is written, and ignores headless workers', () => {
    expect(warmState({ standbys: [sb('ready')] } as never, 'd:/p', 'claude')).toBe('ready');
    expect(warmState({ standbys: [sb('starting')] } as never, 'D:/p', 'claude')).toBe('starting');
    expect(warmState({ standbys: [sb('ready', { headless: true })] } as never, 'D:/p', 'claude')).toBe('none');
    expect(warmState({ standbys: [sb('ready')] } as never, 'D:/other', 'claude')).toBe('none');
    expect(warmState(null, 'D:/p', 'claude')).toBe('none');
  });
  it('does not wait when nothing is starting, and gives up after the limit', async () => {
    const none = api({ standbys: [] });
    expect(await waitForWarm(none, 'D:/p', 'claude', 50, 5)).toBe(false);
    expect(none.status).toHaveBeenCalledTimes(1);
    const slow = api({ standbys: [sb('starting')] });
    expect(await waitForWarm(slow, 'D:/p', 'claude', 30, 5)).toBe(false);
    expect((slow.status as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1);
  });
});
