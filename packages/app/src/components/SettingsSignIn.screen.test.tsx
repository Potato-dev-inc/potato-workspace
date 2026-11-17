// @vitest-environment jsdom
// Settings > Agents with the real panel: an agent that has no sign-in yet shows a "Sign in" button, not the line
// "Run `claude` and log in". No backtick text (no shell command) anywhere on the page, and the button opens the same
// sheet "Sign in again" opens.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeSignInAgain, peekSignInAgain } from '../lib/agentSignIn';
import { BASE_SETTINGS, click, settle } from './settings/test-utils';
import { SettingsPanel, type SettingsApi } from './SettingsPanel';

vi.mock('../lib/accounts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/accounts')>();
  const agents = [
    { agent_id: 'claude', home_env: 'CLAUDE_CONFIG_DIR', login_hint: 'Run `claude` and log in, then close it.' },
    { agent_id: 'codex', home_env: 'CODEX_HOME', login_hint: 'Run `codex` and sign in, then close it.' },
  ];
  const accounts = [{ id: 'a1', agent_id: 'codex', label: 'Work', home: '' }];
  return { ...real, tauriAccountsApi: { ...real.tauriAccountsApi, list: async () => ({ agents, accounts, helper_logins: {} }) } };
});

let host: HTMLDivElement;
let root: Root;
const api: SettingsApi = {
  load: async () => ({ ...BASE_SETTINGS }),
  patch: async () => ({ ...BASE_SETTINGS }),
  findBridgeUrl: async () => null,
  subscribe: () => () => {},
};

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  closeSignInAgain();
  await act(async () => root.unmount());
  host.remove();
});

/** Sign in is a card on the Agents page and starts closed: open it. */
async function openSignInCard() {
  const toggle = host.querySelector<HTMLButtonElement>('.st-closed-group[data-group="Sign in"] .st-adv-toggle');
  expect(toggle).not.toBeNull();
  // The open card is remembered, so a second test may find it open already.
  if (toggle!.getAttribute('aria-expanded') === 'false') await click(toggle);
  await settle(6);
}

describe('Settings > Agents sign-in', () => {
  it('shows a Sign in button where the command line used to be, and no backtick text on the page', async () => {
    await act(async () => root.render(<SettingsPanel open api={api} initialTab="agents" />));
    await settle(10);
    await openSignInCard();
    const main = host.querySelector('.st-main') as HTMLElement;
    const claude = main.querySelector('[data-testid="accounts-claude"]')!;
    const button = claude.querySelector<HTMLButtonElement>('[data-testid="signin-claude"]')!;
    expect(button.textContent).toBe('Sign in');
    expect(main.textContent).not.toContain('`');
    expect(main.textContent).not.toMatch(/Run claude|Run codex|log in, then close/);
    expect(main.querySelector('code')).toBeNull();
    // An agent that already has a sign-in keeps "Sign in again" on that sign-in, and no second plain button.
    expect(main.querySelector('[data-testid="signin-codex"]')).toBeNull();
  });

  it('the button opens the sign-in sheet for that agent', async () => {
    await act(async () => root.render(<SettingsPanel open api={api} initialTab="agents" />));
    await settle(10);
    await openSignInCard();
    await click(host.querySelector('[data-testid="signin-claude"]'));
    expect(peekSignInAgain()).toMatchObject({ agentId: 'claude', accountId: null });
  });
});
