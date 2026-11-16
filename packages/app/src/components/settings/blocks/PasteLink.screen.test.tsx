// @vitest-environment jsdom
// "Paste link" (Discord) and "Paste token" (Telegram) on the real blocks: one press reads the clipboard. Discord then
// saves the link and sends one test alert by itself; Telegram checks the token by itself. The clipboard and the
// test send are mocked; nothing reaches Discord or Telegram.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiscordAlertsApi, DiscordAlertsStatus } from '../../../lib/discordAlerts';
import type { TelegramStatus } from '../../../lib/telegram-api';
import { DiscordAlertsBlock } from './DiscordAlerts';
import { TelegramSetup, type TelegramApi } from './TelegramSetup';
import { click, makeEnv, settle } from '../test-utils';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LINK = 'https://discord.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcdEFGH';
const TOKEN = '123456:ABC-def_ghi';

let host: HTMLDivElement;
let root: Root;
let clipboard: ReturnType<typeof vi.fn>;

/** The clipboard holds `text` for the next press (or refuses to be read when `text` is null). */
function setClipboard(text: string | null) {
  clipboard = vi.fn(async () => {
    if (text === null) throw new Error('denied');
    return text;
  });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: clipboard } });
}

const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label) ?? null;
const text = () => host.textContent ?? '';

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

describe('Discord: Paste link', () => {
  const OFF: DiscordAlertsStatus = { saved: false, tail: null, kinds: { needs_you: true, finished: false, failed: true }, active: false };

  function discordApi() {
    let state = OFF;
    return {
      status: vi.fn(async () => state),
      setUrl: vi.fn(async (_url: string) => {
        state = { ...state, saved: true, tail: 'EFGH', active: true };
        return state;
      }),
      clear: vi.fn(async () => state),
      setKinds: vi.fn(async () => state),
      test: vi.fn(async () => ({ ok: true, message: 'Sent. Look for the message in your Discord channel.' })),
    } satisfies DiscordAlertsApi & Record<string, unknown>;
  }

  it('one press reads the link, saves it, and sends one test alert by itself', async () => {
    setClipboard(LINK);
    const api = discordApi();
    await act(async () => {
      root.render(<DiscordAlertsBlock api={api} />);
    });
    await settle();
    await click(button('Paste link'));
    await settle(4);
    expect(clipboard).toHaveBeenCalledTimes(1);
    expect(api.setUrl).toHaveBeenCalledExactlyOnceWith(LINK);
    expect(api.test).toHaveBeenCalledTimes(1);
    expect(text()).toContain('Sent. Look for the message in your Discord channel.');
    expect(button('Paste link')).toBeNull();
  });

  it('an empty clipboard saves nothing and says what to copy', async () => {
    setClipboard('   ');
    const api = discordApi();
    await act(async () => {
      root.render(<DiscordAlertsBlock api={api} />);
    });
    await settle();
    await click(button('Paste link'));
    await settle(2);
    expect(api.setUrl).not.toHaveBeenCalled();
    expect(api.test).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('The clipboard is empty. Copy the link or token first.');
  });

  it('a clipboard that cannot be read says so and tells the person to paste in the box', async () => {
    setClipboard(null);
    const api = discordApi();
    await act(async () => {
      root.render(<DiscordAlertsBlock api={api} />);
    });
    await settle();
    await click(button('Paste link'));
    await settle(2);
    expect(api.setUrl).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Potato Workspace cannot read the clipboard. Paste into the box instead.');
  });
});

describe('Telegram: Paste token', () => {
  const BASE: TelegramStatus = {
    storeAvailable: true,
    storeLabel: 'Windows Credential Manager',
    tokenSet: false,
    botUsername: null,
    enabled: false,
    state: 'off',
    error: null,
    paired: null,
    pairing: null,
    caps: ['watch', 'answer', 'type'],
    notifyRuns: false,
    shortMode: false,
    lastPollAtMs: null,
    strangersLastHour: 0,
  };

  it('one press reads the token from the clipboard and checks it by itself', async () => {
    setClipboard(TOKEN);
    const api = {
      status: vi.fn(async () => BASE),
      setToken: vi.fn(async (_token: string) => ({ ...BASE, tokenSet: true, botUsername: 'anna_pm_bot' })),
      pairStart: vi.fn(async () => BASE),
      pairDecide: vi.fn(async () => BASE),
      setEnabled: vi.fn(async () => BASE),
      setOptions: vi.fn(async () => BASE),
      forget: vi.fn(async () => BASE),
      onChanged: vi.fn(() => () => undefined),
    };
    await act(async () => {
      root.render(<TelegramSetup env={makeEnv()} api={api as unknown as TelegramApi} />);
    });
    await settle();
    await click(button('Paste token'));
    await settle(3);
    expect(clipboard).toHaveBeenCalledTimes(1);
    expect(api.setToken).toHaveBeenCalledExactlyOnceWith(TOKEN);
    expect(text()).toContain('@anna_pm_bot');
  });
});
