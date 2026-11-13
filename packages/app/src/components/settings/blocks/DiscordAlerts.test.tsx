// @vitest-environment jsdom
// Settings > General > Discord alerts, as a screen: paste a link and save (the field shows a mask and the link is
// gone), Test calls the command and shows its result, the three kinds toggle through the command, Remove goes back.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiscordAlertsApi, DiscordAlertsStatus, DiscordKinds } from '../../../lib/discordAlerts';
import { DiscordAlertsBlock } from './DiscordAlerts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LINK = 'https://discord.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcdEFGH';
const OFF: DiscordAlertsStatus = { saved: false, tail: null, kinds: { needs_you: true, finished: false, failed: true }, active: false };

let host: HTMLDivElement;
let root: Root;

function fakeApi(start: DiscordAlertsStatus = OFF) {
  let state = start;
  const api = {
    status: vi.fn(async () => state),
    setUrl: vi.fn(async (url: string) => {
      if (!url.startsWith('https://discord.com/api/webhooks/')) throw new Error('That is not a Discord link. It should start with https://discord.com/api/webhooks/.');
      state = { ...state, saved: true, tail: 'EFGH', active: true };
      return state;
    }),
    clear: vi.fn(async () => {
      state = { ...state, saved: false, tail: null, active: false };
      return state;
    }),
    setKinds: vi.fn(async (kinds: DiscordKinds) => {
      state = { ...state, kinds };
      return state;
    }),
    test: vi.fn(async () => ({ ok: true, message: 'Sent. Look for the message in your Discord channel.' })),
  };
  return api satisfies DiscordAlertsApi;
}

async function mount(api: DiscordAlertsApi, onSaved?: () => void) {
  await act(async () => {
    root.render(<DiscordAlertsBlock api={api} onSaved={onSaved} />);
  });
}

const field = () => host.querySelector<HTMLInputElement>('input[aria-label="Discord webhook link"]');
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === label) ?? null;
const sw = (label: string) => host.querySelector<HTMLElement>(`[role="switch"][aria-label="${label}"]`);

async function type(el: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const click = (el: HTMLElement) => act(async () => el.click());

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('Discord alerts block', () => {
  it('starts empty and off: a paste field, Save and Send a test disabled, the default kinds', async () => {
    await mount(fakeApi());
    expect(field()?.value).toBe('');
    expect(field()?.type).toBe('password');
    expect(button('Save')?.disabled).toBe(true);
    expect(button('Send a test')?.disabled).toBe(true);
    expect(button('Remove')).toBeNull();
    expect(sw('Needs you')?.getAttribute('aria-checked')).toBe('true');
    expect(sw('Finished')?.getAttribute('aria-checked')).toBe('false');
    expect(sw('Failed')?.getAttribute('aria-checked')).toBe('true');
  });

  it('saving sends the pasted link once, then the field is masked and the link is gone from the screen', async () => {
    const api = fakeApi();
    const onSaved = vi.fn();
    await mount(api, onSaved);
    await type(field()!, `  ${LINK}  `);
    expect(button('Save')?.disabled).toBe(false);
    await click(button('Save')!);
    expect(api.setUrl).toHaveBeenCalledExactlyOnceWith(LINK);
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(field()?.readOnly).toBe(true);
    expect(field()?.value).not.toContain('discord');
    expect(field()?.value).not.toContain('AbCdEf');
    expect(host.innerHTML).not.toContain('AbCdEf');
    expect(host.textContent).toContain('Ends in EFGH');
    expect(button('Save')).toBeNull();
    expect(button('Remove')).not.toBeNull();
    expect(button('Send a test')?.disabled).toBe(false);
  });

  it('a refused link shows the plain reason and keeps the paste field for another try', async () => {
    const api = fakeApi();
    await mount(api);
    await type(field()!, 'https://example.com/hook');
    await click(button('Save')!);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('not a Discord link');
    expect(field()?.readOnly).toBe(false);
    expect(host.textContent).not.toContain('Ends in');
  });

  it('Test calls the command and shows what came back', async () => {
    const api = fakeApi({ ...OFF, saved: true, tail: 'EFGH', active: true });
    await mount(api);
    await click(button('Send a test')!);
    expect(api.test).toHaveBeenCalledTimes(1);
    expect([...host.querySelectorAll('[role="status"]')].map((n) => n.textContent).join(' ')).toContain('Sent. Look for the message');
    api.test.mockResolvedValueOnce({ ok: false, message: 'Discord does not accept that webhook any more. Make a new one.' });
    await click(button('Send a test')!);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Make a new one');
  });

  it('each kind toggles through the command with the other two unchanged', async () => {
    const api = fakeApi({ ...OFF, saved: true, tail: 'EFGH', active: true });
    await mount(api);
    await click(sw('Finished')!);
    expect(api.setKinds).toHaveBeenLastCalledWith({ needs_you: true, finished: true, failed: true });
    expect(sw('Finished')?.getAttribute('aria-checked')).toBe('true');
    await click(sw('Needs you')!);
    expect(api.setKinds).toHaveBeenLastCalledWith({ needs_you: false, finished: true, failed: true });
    await click(sw('Failed')!);
    expect(api.setKinds).toHaveBeenLastCalledWith({ needs_you: false, finished: true, failed: false });
    expect(api.setKinds).toHaveBeenCalledTimes(3);
  });

  it('Remove clears the saved link and brings the paste field back', async () => {
    const api = fakeApi({ ...OFF, saved: true, tail: 'EFGH', active: true });
    await mount(api);
    await click(button('Remove')!);
    expect(api.clear).toHaveBeenCalledTimes(1);
    expect(field()?.readOnly).toBe(false);
    expect(field()?.value).toBe('');
    expect(button('Send a test')?.disabled).toBe(true);
  });

  it('shows nothing outside the desktop app (the status call fails)', async () => {
    const api = fakeApi();
    api.status.mockRejectedValueOnce(new Error('Desktop shell required'));
    await mount(api);
    expect(host.textContent).toBe('');
  });
});
