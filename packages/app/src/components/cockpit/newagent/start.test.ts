import { describe, expect, it, vi } from 'vitest';
import type { StartRequest } from './model';
import { chipChoiceFor, isStartBlock, runStart, setChatModelOn, type StartDeps } from './start';

const req = (extra: Partial<StartRequest> = {}): StartRequest => ({ agentId: 'alpha', folder: '/work/p', isolated: false, runAs: 'terminal', prompt: 'fix it', ...extra });

function deps(extra: Partial<StartDeps> = {}) {
  return {
    newAgent: vi.fn(async (): Promise<string | null> => 'pane-1'),
    startChat: vi.fn(async () => 'chat-1'),
    select: vi.fn(),
    send: vi.fn(async (): Promise<unknown> => undefined),
    notify: vi.fn(),
    ...extra,
  };
}

describe('runStart', () => {
  it('starts a terminal pane the way the + menu does, then queues the first message', async () => {
    const d = deps();
    expect(await runStart(req({ accountId: 'acc', isolated: true }), d)).toBe('pane-1');
    expect(d.newAgent).toHaveBeenCalledWith('alpha', 'acc', true, '/work/p');
    expect(d.send).toHaveBeenCalledWith('pane-1', 'fix it');
    expect(d.startChat).not.toHaveBeenCalled();
  });

  it('starts a chat session in the folder, opens it, and queues the message', async () => {
    const d = deps();
    expect(await runStart(req({ runAs: 'chat' }), d)).toBe('chat-1');
    expect(d.startChat).toHaveBeenCalledWith('alpha', '/work/p');
    expect(d.select).toHaveBeenCalledWith('chat-1');
    expect(d.send).toHaveBeenCalledWith('chat-1', 'fix it');
    expect(d.newAgent).not.toHaveBeenCalled();
  });

  it('a chat without a folder starts nothing and says so', async () => {
    const d = deps();
    expect(await runStart(req({ runAs: 'chat', folder: undefined }), d)).toBeNull();
    expect(d.startChat).not.toHaveBeenCalled();
    expect(d.notify).toHaveBeenCalledWith('Pick a folder for a chat session.');
  });

  it('a chat that cannot start tells the person and sends nothing', async () => {
    const d = deps({ startChat: vi.fn(async () => Promise.reject(new Error('ACP_LABS_OFF: Chat sessions are off.'))) });
    expect(await runStart(req({ runAs: 'chat' }), d)).toBeNull();
    expect(d.notify).toHaveBeenCalledWith('ACP_LABS_OFF: Chat sessions are off.');
    expect(d.send).not.toHaveBeenCalled();
  });

  it('a pane that did not start sends nothing (the starting view says why)', async () => {
    const d = deps({ newAgent: vi.fn(async () => null) });
    expect(await runStart(req(), d)).toBeNull();
    expect(d.send).not.toHaveBeenCalled();
    expect(d.notify).not.toHaveBeenCalled();
  });

  it('keeps the pane when only the first message fails, and says so', async () => {
    const d = deps({ send: vi.fn(async () => Promise.reject('The agent is not running.')) });
    expect(await runStart(req(), d)).toBe('pane-1');
    expect(d.notify).toHaveBeenCalledWith('The agent started, but your message was not sent: The agent is not running.');
  });

  it('a chat that needs its add-on or a sign-in hands the page a block and announces nothing', async () => {
    for (const [code, kind] of [['ACP_ADDON_MISSING', 'addon'], ['ACP_SIGN_IN_NEEDED', 'signin']] as const) {
      const d = deps({ startChat: vi.fn(async () => Promise.reject(`${code}: Something plain.`)) });
      const result = await runStart(req({ runAs: 'chat' }), d);
      expect(isStartBlock(result)).toBe(true);
      expect(result).toMatchObject({ blocked: kind, agentId: 'alpha' });
      expect(d.notify).not.toHaveBeenCalled();
      expect(d.send).not.toHaveBeenCalled();
    }
  });

  it('the same words from a terminal start are just an error', async () => {
    const d = deps({ newAgent: vi.fn(async () => Promise.reject(new Error('ACP_SIGN_IN_NEEDED: x'))) });
    expect(await runStart(req(), d)).toBeNull();
    expect(d.notify).toHaveBeenCalledWith('ACP_SIGN_IN_NEEDED: x');
  });
});

describe('a chat on a borrowed sign-in', () => {
  it('hands the lent sign-in to the chat start, and the real start sends it as accountId', async () => {
    const startChat = vi.fn(async () => 'chat-1');
    const deps = { newAgent: vi.fn(), startChat, select: vi.fn(), send: vi.fn(async () => undefined), notify: vi.fn() };
    const id = await runStart({ agentId: 'claude', accountId: 'lend:g1', folder: 'C:\p', isolated: false, runAs: 'chat', prompt: 'hi' }, deps);
    expect(id).toBe('chat-1');
    expect(startChat).toHaveBeenCalledWith('claude', 'C:\p', 'lend:g1');
    expect(deps.newAgent).not.toHaveBeenCalled();
  });
});

describe('runStart with a model', () => {
  it('a terminal start passes the model to the agent launch', async () => {
    const d = deps();
    await runStart(req({ model: 'gpt-5-mini' }), d);
    expect(d.newAgent).toHaveBeenCalledWith('alpha', undefined, false, '/work/p', 'gpt-5-mini');
  });

  it('a chat start sets the model right after the session starts, before the first message', async () => {
    const order: string[] = [];
    const d = deps({
      setChatModel: vi.fn(async () => {
        order.push('model');
        return null;
      }),
      send: vi.fn(async (): Promise<unknown> => order.push('send')),
    });
    expect(await runStart(req({ runAs: 'chat', model: 'gpt-5-mini' }), d)).toBe('chat-1');
    expect(d.setChatModel).toHaveBeenCalledWith('chat-1', 'gpt-5-mini');
    expect(order).toEqual(['model', 'send']);
  });

  it('a chat that cannot take the model keeps going on its default and says so', async () => {
    const d = deps({ setChatModel: vi.fn(async () => 'This chat does not list "x", so it uses its default model.') });
    expect(await runStart(req({ runAs: 'chat', model: 'x' }), d)).toBe('chat-1');
    expect(d.notify).toHaveBeenCalledWith('This chat does not list "x", so it uses its default model.');
    expect(d.send).toHaveBeenCalled();
  });

  it('with no model nothing is set', async () => {
    const d = deps({ setChatModel: vi.fn(async () => null) });
    await runStart(req({ runAs: 'chat' }), d);
    expect(d.setChatModel).not.toHaveBeenCalled();
  });
});

describe('setChatModelOn', () => {
  const state = (value: string) => ({ configOptions: [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: value, options: [{ value: 'a', name: 'Alpha One' }, { value: 'b', name: 'Beta Two' }] }] }) as never;

  it('matches by id or by shown name, any case', () => {
    const choices = [{ value: 'a', name: 'Alpha One' }];
    expect(chipChoiceFor('A', choices)).toBe('a');
    expect(chipChoiceFor('alpha one', choices)).toBe('a');
    expect(chipChoiceFor('zzz', choices)).toBeNull();
  });

  it('waits for the settings to appear, then sets the model', async () => {
    const api = { state: vi.fn().mockResolvedValueOnce(null).mockResolvedValue(state('a')), setConfig: vi.fn(async () => state('b')) };
    expect(await setChatModelOn('p', 'b', api, async () => undefined)).toBeNull();
    expect(api.setConfig).toHaveBeenCalledWith('p', 'model', 'b');
  });

  it('does nothing when the chat is already on it, and explains a model it does not list', async () => {
    const api = { state: vi.fn(async () => state('a')), setConfig: vi.fn() };
    expect(await setChatModelOn('p', 'a', api, async () => undefined)).toBeNull();
    expect(api.setConfig).not.toHaveBeenCalled();
    expect(await setChatModelOn('p', 'nope', api, async () => undefined)).toContain('does not list "nope"');
  });
});
