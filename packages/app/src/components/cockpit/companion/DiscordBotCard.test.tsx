// @vitest-environment jsdom
// The Discord bot card, through the real companion page. The token is write-only: after Save it is gone from the page,
// and it appears in exactly one call (set_token).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeCompanionTransport, type CompanionView, type DiscordBotSettings, type DiscordBotStatus, type DiscordBotTransport } from '../../../lib/companion';
import { en } from '../../../i18n/en';
import { zhTW } from '../../../i18n/zh-TW';
import { CompanionPage } from './CompanionPage';

vi.mock('../../chat/SessionChatPanel', () => ({ SessionChatPanel: () => null }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

const TOKEN = 'MTA5ODc2NTQzMjEwOTg3NjU0.Gabcde.secretsecretsecret-AB12';
const G = '111111111111111111';
const C1 = '222222222222222222';
const C2 = '333333333333333333';
const base: DiscordBotSettings = { on: false, allow: [], owners: [], dms: 'owners', names: [], gate: 'heuristic', budget: { count: 3, minutes: 60 } };
const statusOf = (over: Partial<DiscordBotStatus> = {}): DiscordBotStatus => ({
  enabled: true,
  storeAvailable: true,
  set: false,
  last4: null,
  botName: null,
  state: 'no_token',
  callsToday: 4,
  callsCap: 50,
  settings: base,
  ...over,
});

const companion: CompanionView = {
  id: 'mochi',
  name: 'Mochi',
  avatar: 'mochi',
  persona: 'calm',
  agentType: 'claude',
  agentLabel: 'Claude',
  folder: 'C:\\work\\home',
  folderName: 'home',
  state: 'idle',
  stateLine: 'Here.',
  paneId: 'companion-mochi',
  needs: null,
  pendingMemory: 0,
  nextCheckin: null,
  restarts: 0,
  autoStart: true,
};

/** A fake bot that keeps its own state and records every call (the token only ever shows in setToken). */
function fakeBot(start: DiscordBotStatus, opts: { rejectToken?: string } = {}) {
  let st = start;
  const calls: { method: string; args: unknown[] }[] = [];
  const bot: DiscordBotTransport = {
    status: vi.fn(async (id) => {
      calls.push({ method: 'status', args: [id] });
      return st;
    }),
    setToken: vi.fn(async (id, token) => {
      calls.push({ method: 'setToken', args: [id, token] });
      if (opts.rejectToken) throw new Error(opts.rejectToken);
      st = { ...st, set: true, last4: token.slice(-4), state: 'connecting' };
      return st;
    }),
    clear: vi.fn(async (id) => {
      calls.push({ method: 'clear', args: [id] });
      st = { ...st, set: false, last4: null, state: 'no_token', settings: { ...st.settings, on: false } };
      return st;
    }),
    saveSettings: vi.fn(async (id, settings) => {
      calls.push({ method: 'saveSettings', args: [id, settings] });
      st = { ...st, settings };
      return st;
    }),
    test: vi.fn(async (id) => {
      calls.push({ method: 'test', args: [id] });
      return { ok: true, message: 'The token is saved and looks right.' };
    }),
  };
  return { bot, calls };
}

async function render(bot?: DiscordBotTransport) {
  const transport = fakeCompanionTransport({ companions: [companion], memory: { soul: 'Warm.', user: '', memory: '', pending: [] } });
  if (bot) transport.discordBot = bot;
  await act(async () =>
    root.render(<CompanionPage companion={companion} transport={transport} onShowTerminal={vi.fn()} onOpenCard={vi.fn()} onNotify={vi.fn()} onChanged={vi.fn()} onArchived={vi.fn()} />),
  );
  await act(async () => {});
}
async function rerender(bot: DiscordBotTransport) {
  await act(async () => root.unmount());
  root = createRoot(host);
  await render(bot);
}

const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label);
const input = (label: string) => host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
const byId = (id: string) => host.querySelector<HTMLInputElement>(`#${id}`)!;
const tokenInput = () => byId('ck-discord-token');
const onSwitch = () => host.querySelector<HTMLButtonElement>('[role="switch"][aria-labelledby="ck-discord-on-label"]')!;
async function type(el: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const click = (el: Element | null | undefined) => act(async () => (el as HTMLElement).click());
const everything = () => host.innerHTML + host.textContent + [...host.querySelectorAll('input')].map((i) => i.value).join('|');

describe('DiscordBotCard on the companion page', () => {
  it('is hidden when the transport has no bot, and when the Labs switch is off', async () => {
    await render();
    expect(host.textContent).not.toContain('Discord bot');
    await rerender(fakeBot(statusOf({ enabled: false })).bot);
    expect(host.textContent).not.toContain('Discord bot');
  });

  it('says it answers nowhere until a server is added, and the switch waits for a token', async () => {
    await render(fakeBot(statusOf()).bot);
    expect(host.textContent).toContain('Discord bot');
    expect(host.textContent).toContain('Add a bot token to start.');
    expect(host.textContent).toContain('It answers nowhere until you add a server.');
    expect(onSwitch().disabled).toBe(true);
    expect(host.textContent).toContain('Messages from Discord are never run as commands. The bot has no tools.');
    expect(host.textContent).toContain('Today it used 4 of 50 AI calls.');
    expect(host.textContent).not.toContain('JEV');
  });

  it('keeps the token write-only: password field, gone after Save, in one call only', async () => {
    const { bot, calls } = fakeBot(statusOf());
    await render(bot);
    expect(tokenInput().type).toBe('password');
    expect(tokenInput().autocomplete).toBe('off');
    await type(tokenInput(), TOKEN);
    await click(button('Save'));
    expect(host.textContent).toContain('Saved, ends in AB12');
    expect(host.querySelector('#ck-discord-token')).toBeNull();
    expect(everything()).not.toContain(TOKEN);
    expect(everything()).not.toContain('secretsecret');
    expect(calls.filter((c) => JSON.stringify(c.args).includes(TOKEN)).map((c) => c.method)).toEqual(['setToken']);
    expect(JSON.stringify(Object.entries(localStorage))).not.toContain('secretsecret');
    expect(button('Replace')).toBeTruthy();
    expect(button('Remove')).toBeTruthy();
  });

  it('says only "Saved" when the end of the token is not known', async () => {
    await render(fakeBot(statusOf({ set: true, last4: null, state: 'online', botName: 'Mochi Bot' })).bot);
    expect(host.textContent).toContain('Online as Mochi Bot');
    expect(host.textContent).toContain('Saved');
    expect(host.textContent).not.toContain('ends in');
  });

  it('a failed save clears the field and shows the sentence, never the token', async () => {
    await render(fakeBot(statusOf(), { rejectToken: 'That does not look like a Discord bot token.' }).bot);
    await type(tokenInput(), TOKEN);
    await click(button('Save'));
    expect(tokenInput().value).toBe('');
    expect(host.textContent).toContain('That does not look like a Discord bot token.');
    expect(everything()).not.toContain(TOKEN);
  });

  it('Replace asks for a new token, and Remove turns the bot off', async () => {
    const { bot, calls } = fakeBot(statusOf({ set: true, last4: 'ab12', state: 'online', botName: 'Mochi Bot', settings: { ...base, on: true } }));
    await render(bot);
    await click(button('Replace'));
    expect(tokenInput().value).toBe('');
    await rerender(bot);
    await click(button('Remove'));
    expect(calls.map((c) => c.method)).toContain('clear');
    expect(host.textContent).toContain('Add a bot token to start.');
    expect(tokenInput()).toBeTruthy();
    expect(onSwitch().disabled).toBe(true);
  });

  it('with no safe credential store it says so and the token field is off', async () => {
    await render(fakeBot(statusOf({ storeAvailable: false })).bot);
    expect(host.textContent).toContain("This computer has no safe place to keep the token, so the bot can't be used.");
    expect(tokenInput().disabled).toBe(true);
  });

  it('shows a plain line for each problem state', async () => {
    const cases: [DiscordBotStatus['state'], string][] = [
      ['token_rejected', 'Discord did not accept the token. Replace it.'],
      ['intent_missing', 'Turn on Message Content in the Discord developer page.'],
      ['stopped', 'Not connected.'],
    ];
    for (const [state, line] of cases) {
      await rerender(fakeBot(statusOf({ set: true, last4: 'ab12', state })).bot);
      expect(host.textContent, state).toContain(line);
    }
  });

  it('the allow list: reject bad ids, add a server with channels (ambient off), save, remove', async () => {
    const { bot, calls } = fakeBot(statusOf({ set: true, last4: 'ab12', state: 'stopped' }));
    await render(bot);
    await type(input('Server ID'), '123');
    await type(input('Channel IDs'), C1);
    await click(button('Add server'));
    expect(host.textContent).toContain('A server ID is 15 to 20 digits.');
    expect(host.querySelectorAll('[data-testid="discord-allow-row"]')).toHaveLength(0);
    await type(input('Server ID'), G);
    await type(input('Channel IDs'), `${C1}, 12ab`);
    await click(button('Add server'));
    expect(host.textContent).toContain('Each channel ID is 15 to 20 digits.');
    await type(input('Channel IDs'), `${C1} ${C2}`);
    await click(button('Add server'));
    const rows = host.querySelectorAll('[data-testid="discord-allow-row"]');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain(G);
    expect(rows[0].textContent).toContain(C1);
    expect(rows[0].querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);
    expect(host.textContent).not.toContain('It answers nowhere');
    await click(button('Save settings'));
    const saved = calls.find((c) => c.method === 'saveSettings')!.args[1] as DiscordBotSettings;
    expect(saved.allow).toEqual([{ guildId: G, channels: [C1, C2], ambient: false }]);
    await click(host.querySelector('[data-testid="discord-allow-row"] button'));
    expect(host.querySelectorAll('[data-testid="discord-allow-row"]')).toHaveLength(0);
    expect(host.textContent).toContain('It answers nowhere until you add a server.');
  });

  it('ambient is chosen per server, and owners, names, gate, direct messages and budget are saved', async () => {
    const { bot, calls } = fakeBot(statusOf({ set: true, last4: 'ab12', state: 'stopped' }));
    await render(bot);
    await type(input('Server ID'), G);
    await type(input('Channel IDs'), C1);
    await click(host.querySelector('.ck-discord-block input[type="checkbox"]'));
    await click(button('Add server'));
    await type(byId('ck-discord-owners'), '444444444444444444, 555555555555555555');
    await type(byId('ck-discord-names'), 'Mochi, mo');
    await act(async () => {
      const gate = host.querySelector<HTMLSelectElement>('#ck-discord-gate')!;
      gate.value = 'llm';
      gate.dispatchEvent(new Event('change', { bubbles: true }));
      const dms = host.querySelector<HTMLSelectElement>('#ck-discord-dms')!;
      dms.value = 'off';
      dms.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await type(input('Number of joined-in replies'), '5');
    await type(input('Minutes'), '30');
    await click(button('Save settings'));
    const s = calls.find((c) => c.method === 'saveSettings')!.args[1] as DiscordBotSettings;
    expect(s).toMatchObject({
      allow: [{ guildId: G, ambient: true }],
      owners: ['444444444444444444', '555555555555555555'],
      names: ['Mochi', 'mo'],
      gate: 'llm',
      dms: 'off',
      budget: { count: 5, minutes: 30 },
    });
    expect(host.textContent).toContain('Settings saved.');
  });

  it('a bad owner id is refused before saving', async () => {
    const { bot, calls } = fakeBot(statusOf({ set: true, last4: 'ab12' }));
    await render(bot);
    await type(byId('ck-discord-owners'), 'ren');
    await click(button('Save settings'));
    expect(host.textContent).toContain('Each owner ID is 15 to 20 digits.');
    expect(calls.some((c) => c.method === 'saveSettings')).toBe(false);
  });

  it('the on switch saves on:true once a token is saved', async () => {
    const { bot, calls } = fakeBot(statusOf({ set: true, last4: 'ab12', state: 'off' }));
    await render(bot);
    expect(onSwitch().disabled).toBe(false);
    await click(onSwitch());
    expect((calls.find((c) => c.method === 'saveSettings')!.args[1] as DiscordBotSettings).on).toBe(true);
    expect(onSwitch().getAttribute('aria-checked')).toBe('true');
  });

  it('Check shows the message from the PC', async () => {
    const { bot, calls } = fakeBot(statusOf({ set: true, last4: 'ab12' }));
    await render(bot);
    await click(button('Check'));
    expect(calls.map((c) => c.method)).toContain('test');
    expect(host.textContent).toContain('The token is saved and looks right.');
  });

  it('both languages have every key, with the same placeholders', () => {
    const keys = Object.keys(en).filter((k) => k.startsWith('companion.discord.'));
    expect(keys.length).toBeGreaterThan(40);
    const holes = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(',');
    for (const k of keys) {
      const zh = (zhTW as Record<string, string | undefined>)[k];
      expect(zh, k).toBeTruthy();
      expect(holes(zh!), k).toBe(holes((en as Record<string, string>)[k]));
    }
  });
});
