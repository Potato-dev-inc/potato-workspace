// @vitest-environment jsdom
// Every Settings page in Traditional Chinese: no visible English (page title, group headings, every row's label and hint,
// buttons, options, aria-labels). Brand names, units and code stay as they are (see ENGLISH_ALLOW and ALLOW below).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '@potato-workspace/shared';
import { useChinese, useEnglish, visibleEnglish } from '../../i18n/test-utils';
import { SettingsPanel, type SettingsApi } from '../SettingsPanel';
import { BASE_SETTINGS, settle } from './test-utils';

vi.mock('../../lib/tauri', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../lib/tauri')>();
  return { ...orig, tauri: { ...orig.tauri, autostartGet: vi.fn(async () => false), autostartSet: vi.fn(async () => undefined) } };
});

let host: HTMLDivElement;
let root: Root;

const LABS_ON = { acp_chat_enabled: true, model_bridge_enabled: true, lend_enabled: true, show_developer_settings: true } as unknown as Settings;

const api = (extra: Partial<Settings> = {}): SettingsApi => ({
  load: vi.fn(async () => ({ ...BASE_SETTINGS, ...extra }) as Settings),
  patch: vi.fn(async () => ({ ...BASE_SETTINGS, ...extra }) as Settings),
  findBridgeUrl: vi.fn(async () => 'http://127.0.0.1:17321'),
  subscribe: vi.fn(() => () => undefined),
});

beforeEach(() => {
  useChinese();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  useEnglish();
});

/** Words that stay English here on purpose: product, tool and file names a person types or reads as code. */
const ALLOW = ['Claude', 'Codex', 'Cursor', 'OpenCode', 'OpenRouter', 'Cloudflare', 'Zero', 'Trust', 'Docker', 'Dropbox', 'WSL', 'Node', 'npx', 'QR', 'Telegram', 'BotFather', 'Live', 'Room', 'Esc', 'Ctrl', 'Alt', 'Shift', 'Win', 'Enter', 'Space', 'Tab', 'Desktop', 'Git', 'Zip', 'webhook', 'Webhooks', 'Webhook', 'pull', 'request', 'issue', 'CI', 'Potato', 'MCP', 'HANDOFF', 'gh', 'auth', 'login', 'Spaces', 'Kimi', 'Agent', 'IDE', 'English', 'Left', 'Right', 'Up', 'Down', 'Home', 'End', 'mcp', 'json', 'codex', 'config', 'toml', 'opencode', 'pm', 'toolbelt', 'bak', 'Beta', 'token', 'Command', 'Prompt', 'PowerShell', 'Shell'];

async function page(id: string, extra: Partial<Settings> = {}): Promise<Element> {
  await act(async () => {
    root.render(<SettingsPanel open initialTab={id as never} api={api(extra)} onClose={() => undefined} />);
  });
  await settle(10);
  // Open every closed group and the Advanced fold: the rows inside them are on the page too.
  for (let i = 0; i < 12; i++) {
    const closed = Array.from(host.querySelectorAll<HTMLButtonElement>('button.st-adv-toggle[aria-expanded="false"]'));
    if (closed.length === 0) break;
    await act(async () => closed.forEach((b) => b.click()));
    await settle(4);
  }
  const main = host.querySelector('.st-main')!;
  // Not part of this check: the agent definitions block (another area), and what a missing desktop shell answers in a test.
  main.querySelectorAll('[data-row="definitions"]').forEach((el) => el.remove());
  return main;
}

/** English found on a page, without the answers a browser test gets because there is no desktop shell behind the app. */
function english(main: Element): string[] {
  return visibleEnglish(main, ALLOW).filter((line) => !/Desktop shell required|Cannot read properties/.test(line));
}

describe('Settings pages in Traditional Chinese have no visible English', () => {
  for (const id of ['agents', 'helpers', 'look', 'connect', 'keys', 'shortcuts', 'advanced']) {
    it(`the ${id} page`, async () => {
      const main = await page(id);
      expect(main.textContent?.trim().length ?? 0).toBeGreaterThan(20);
      expect(english(main)).toEqual([]);
    });
  }

  it('the agents and advanced pages with the early features and developer rows switched on', async () => {
    for (const id of ['agents', 'helpers', 'advanced']) {
      const main = await page(id, LABS_ON);
      expect(english(main), id).toEqual([]);
    }
  });

  it('the Labs list on the advanced page names every early feature in Chinese', async () => {
    const main = await page('advanced');
    const names = Array.from(main.querySelectorAll('.st-labs-name')).map((el) => el.textContent ?? '');
    expect(names.length).toBeGreaterThan(5);
    for (const name of names) expect(/[一-鿿]/.test(name) || name === 'Telegram', name).toBe(true);
  });
});
