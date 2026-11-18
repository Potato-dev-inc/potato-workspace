// @vitest-environment jsdom
// Connect > Devices > "Other computers (SSH)", through the real page: saved SSH machines, one "Add a computer" button that opens the
// existing SSH form (without its extra settings), and a click on a machine opens its terminal place. Only the command layers are fakes.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILD_BOX, SshFake } from '../../dev/ssh-fixtures';
import { setLanguagePref } from '../../i18n';
import { click, settle } from '../settings/test-utils';
import { ConnectPage } from './ConnectPage';
import { makeApi, q, text } from './connect-test-utils';

const FORBIDDEN = /relay|worker|tunnel|\bports?\b|key path|advanced|more options|technical details/i;

let host: HTMLDivElement;
beforeEach(() => {
  window.localStorage.clear();
  setLanguagePref('en', false);
  host = document.createElement('div');
  document.body.appendChild(host);
});
afterEach(() => {
  host.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function mount(ssh: SshFake, onOpenPane = vi.fn()) {
  const root = createRoot(host);
  await act(async () => root.render(<ConnectPage tab="devices" onTab={() => undefined} onOpenPane={onOpenPane} api={{ ...makeApi(), ssh }} />));
  await settle(10);
  return { root, onOpenPane };
}

describe('Connect > Devices > Other computers (SSH)', () => {
  it('lists the saved machines with a state and one Add a computer button, in plain words', async () => {
    const { root } = await mount(new SshFake({ hosts: [BUILD_BOX] }));
    const group = q('[data-testid="connect-ssh-group"]')!;
    expect(group.textContent).toContain('Other computers (SSH)');
    expect(text('[data-testid="connect-ssh-ssh-1"]')).toContain('Build box');
    expect(text('[data-testid="connect-ssh-ssh-1"]')).toContain('Last checked');
    expect(q('[data-testid="connect-ssh-add"]')?.textContent).toBe('Add a computer');
    expect(group.textContent).not.toMatch(FORBIDDEN);
    await act(async () => root.unmount());
  });

  it('Add a computer opens the existing SSH form, plain, and a saved machine shows up', async () => {
    const ssh = new SshFake();
    const { root } = await mount(ssh);
    expect(q('[data-testid="connect-ssh-empty"]')).not.toBeNull();
    await click(q('[data-testid="connect-ssh-add"]'));
    expect(q('[data-testid="ssh-form"]')).not.toBeNull();
    expect(q('[data-testid="ssh-port"]')).toBeNull();
    expect(q('[data-testid="ssh-key"]')).toBeNull();
    expect(text('[data-testid="connect-ssh-add-sheet"]')).not.toMatch(FORBIDDEN);
    expect(q('[data-testid="connect-ssh-add-sheet"] details')).toBeNull();
    await act(async () => root.unmount());
  });

  it('a machine opens its terminal place and hands the pane to the app', async () => {
    const ssh = new SshFake({ hosts: [BUILD_BOX] });
    const { root, onOpenPane } = await mount(ssh);
    await click(q('[data-testid="connect-ssh-ssh-1"] .cx-namebtn'));
    expect(q('[data-testid="ssh-panel"]')).not.toBeNull();
    const start = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="connect-ssh-sheet"] button')].find((b) => b.textContent === 'Open terminal');
    expect(start).toBeTruthy();
    await click(start);
    await settle(5);
    expect(ssh.opened[0]?.id).toBe('ssh-1');
    expect(onOpenPane).toHaveBeenCalled();
    await act(async () => root.unmount());
  });
});

describe('Other computers (SSH): plain wording and Remove', () => {
  it('a wrong sign-in does not mention a key file, and Remove asks first and says plainly when it fails', async () => {
    const ssh = new SshFake({ hosts: [BUILD_BOX], check: { state: 'wrong_key', message: '', os: null, programs: [] } });
    const { root } = await mount(ssh);
    await click(q('[data-testid="connect-ssh-check-ssh-1"]'));
    await settle(5);
    expect(text('[data-testid="connect-ssh-ssh-1"]')).not.toMatch(/key file/i);
    expect(text('[data-testid="connect-ssh-ssh-1"]')).toContain('sign-in did not work');
    await click(q('[data-testid="connect-ssh-ssh-1"] .cx-namebtn'));
    await click(q('[data-testid="connect-ssh-remove-ssh-1"]'));
    expect(q('[data-testid="connect-ssh-remove-confirm"]')).not.toBeNull();
    expect(ssh.calls.some((c) => c.method === 'remove')).toBe(false);
    vi.spyOn(ssh, 'remove').mockRejectedValueOnce(new Error('boom'));
    await click(q('[data-testid="connect-ssh-remove-yes"]'));
    await settle(5);
    expect(text('[data-testid="connect-ssh-remove-error"]')).toBe('Could not remove it. Try again.');
    await click(q('[data-testid="connect-ssh-remove-yes"]'));
    await settle(5);
    expect(q('[data-testid="connect-ssh-sheet"]')).toBeNull();
    expect(q('[data-testid="connect-ssh-ssh-1"]')).toBeNull();
    await act(async () => root.unmount());
  });
});
