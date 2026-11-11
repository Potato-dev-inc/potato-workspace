// @vitest-environment jsdom
// An agent with several sign-ins starts under the one used last, without the extra step.
// Shift+Enter (or Change) picks another one.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LAST_SIGN_IN_KEY, type Account, type AccountsApi } from '../../lib/accounts';
import { NewAgentMenu } from './NewAgentMenu';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ENTRIES = [{ type: 'claude', label: 'Claude' }, { type: 'codex', label: 'Codex' }];
const WORK: Account = { id: 'acc_1', agent_id: 'claude', label: 'Work', home: 'C:/a' };
const HOME: Account = { id: 'acc_2', agent_id: 'claude', label: 'Personal', home: 'C:/b' };

const api = (accounts: Account[]) => ({ list: async () => ({ agents: [], accounts }), add: vi.fn(), rename: vi.fn(), remove: vi.fn(), openLoginPane: vi.fn() }) as unknown as AccountsApi;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  window.localStorage.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  window.localStorage.clear();
});

const item = (label: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes(label));
async function mount(accounts: Account[]) {
  const onStart = vi.fn();
  await act(async () => {
    root.render(<NewAgentMenu entries={ENTRIES} readyAgents={new Set()} onStart={onStart} onClose={vi.fn()} accountsApi={api(accounts)} />);
  });
  return { onStart };
}

describe('the sign-in used last', () => {
  it('asks the first time, then starts under the same sign-in without asking', async () => {
    const first = await mount([WORK, HOME]);
    await act(async () => item('Claude')!.click());
    await act(async () => item('Personal')!.click());
    expect(first.onStart).toHaveBeenCalledWith('claude', 'acc_2');
    expect(JSON.parse(window.localStorage.getItem(LAST_SIGN_IN_KEY)!)).toEqual({ claude: 'acc_2' });
    await act(async () => root.unmount());
    root = createRoot(host);
    const second = await mount([WORK, HOME]);
    expect(item('Claude')!.textContent).toContain('Personal');
    await act(async () => item('Claude')!.click());
    expect(second.onStart).toHaveBeenCalledWith('claude', 'acc_2');
    expect(host.textContent).not.toContain('Default sign-in');
  });

  it('remembers the default sign-in too', async () => {
    window.localStorage.setItem(LAST_SIGN_IN_KEY, JSON.stringify({ claude: '' }));
    const { onStart } = await mount([WORK, HOME]);
    await act(async () => item('Claude')!.click());
    expect(onStart).toHaveBeenCalledWith('claude', undefined);
  });

  it('asks again when the remembered sign-in was removed', async () => {
    window.localStorage.setItem(LAST_SIGN_IN_KEY, JSON.stringify({ claude: 'acc_gone' }));
    const { onStart } = await mount([WORK, HOME]);
    await act(async () => item('Claude')!.click());
    expect(onStart).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Default sign-in');
  });

  it('falls back to asking when the saved text is corrupt', async () => {
    window.localStorage.setItem(LAST_SIGN_IN_KEY, '{nope');
    const { onStart } = await mount([WORK, HOME]);
    await act(async () => item('Claude')!.click());
    expect(onStart).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Default sign-in');
  });

  it('Shift+Enter on the row shows the choice even when one is remembered', async () => {
    window.localStorage.setItem(LAST_SIGN_IN_KEY, JSON.stringify({ claude: 'acc_1' }));
    const { onStart } = await mount([WORK, HOME]);
    await act(async () => {
      item('Claude')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
    });
    expect(onStart).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Personal');
    await act(async () => item('Personal')!.click());
    expect(onStart).toHaveBeenCalledWith('claude', 'acc_2');
  });

  it('the Change button next to the row shows the choice', async () => {
    window.localStorage.setItem(LAST_SIGN_IN_KEY, JSON.stringify({ claude: 'acc_1' }));
    const { onStart } = await mount([WORK, HOME]);
    await act(async () => item('Change')!.click());
    expect(onStart).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Default sign-in');
  });

  it('an agent with one way to sign in has no Change button', async () => {
    await mount([]);
    expect(item('Change')).toBeUndefined();
  });
});
