// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountsApi, AccountsOverview } from '../../../lib/accounts';
import { fallbackListing } from '../../../lib/agentRegistry';
import { AccountsGroup } from './AccountsGroup';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REGISTRY = fallbackListing();
vi.mock('../../../lib/agentRegistry', async (orig) => ({
  ...(await orig<typeof import('../../../lib/agentRegistry')>()),
  useAgentRegistry: () => REGISTRY,
}));

const OVERVIEW: AccountsOverview = {
  agents: [{ agent_id: 'claude', home_env: 'CLAUDE_CONFIG_DIR', login_hint: 'Run `claude` and log in, then close it.' }],
  accounts: [
    { id: 'a1', agent_id: 'claude', label: 'Work', home: 'C:/data/a1' },
    { id: 'a2', agent_id: 'claude', label: 'Home', home: 'C:/data/a2' },
  ],
  helper_logins: {},
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const render = (api: Partial<AccountsApi>) =>
  act(async () => {
    root.render(<AccountsGroup api={api as AccountsApi} />);
  });

describe('AccountsGroup failures', () => {
  it('puts the saved name back when a rename is rejected', async () => {
    const api = {
      list: vi.fn(async () => OVERVIEW),
      rename: vi.fn(async () => {
        throw new Error('That name is already used.');
      }),
    };
    await render(api);
    const input = host.querySelector('input[aria-label="Name of Home"]') as HTMLInputElement;
    await act(async () => {
      input.focus();
      input.value = 'Work';
      input.blur();
    });
    expect(api.rename).toHaveBeenCalledWith('a2', 'Work');
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('already used');
    expect((host.querySelector('input[aria-label="Name of Home"]') as HTMLInputElement).value).toBe('Home');
  });

  it('keeps the accounts and shows an error when a refresh fails', async () => {
    const api = {
      list: vi.fn().mockResolvedValueOnce(OVERVIEW).mockRejectedValue(new Error('backend busy')),
      remove: vi.fn(async () => false),
    };
    await render(api);
    const remove = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Remove')!;
    await act(async () => remove.click());
    expect(host.querySelector('input[aria-label="Name of Work"]')).not.toBeNull();
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('backend busy');
  });

  it('stays hidden when the very first load fails', async () => {
    await render({ list: vi.fn(async () => Promise.reject(new Error('no shell'))) });
    expect(host.textContent).toBe('');
  });
});
