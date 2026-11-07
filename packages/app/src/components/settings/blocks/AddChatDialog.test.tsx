// @vitest-environment jsdom
// "Add chat (ACP)": detect -> best guess -> confirm (no typing) -> set with confirmed true; no guess / error / timeout -> form; a refusal shows the backend's text; the
// Settings rows (add / remove / reason) and the "+" menu hint (only for agents that can get a chat, Labs on).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import type { AcpLaneAgent, AcpLaneView, OverlayDetect, OverlayOption, OverlayProgress } from '../../../lib/acpChat';
import { tauriAcpChatApi, addableChat, authorsText, firstAvailable, normalizeLaneView, normalizeOptions, registrySentence } from '../../../lib/acpChat';
import { AddChatDialog, commandLine, confirmSentence, DETECT_TIMEOUT_MS } from './AddChatDialog';
import { AgentLaneRows } from './AgentLaneRows';
import { NewAgentMenu } from '../../cockpit/NewAgentMenu';
import type { AccountsApi } from '../../../lib/accounts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const detected: OverlayDetect = {
  ok: true,
  command: 'fake-agent',
  candidates: [
    { command: 'fake-agent', args: ['acp', '--quiet'], evidence: 'acp  Start the chat server', confidence: 'high' },
    { command: 'fake-bridge', args: ['--stdio'], evidence: 'fake-bridge  over stdio', confidence: 'medium' },
  ],
  stdio_hint: null,
  mentions_protocol: true,
};
const row = (over: Partial<AcpLaneAgent> = {}): AcpLaneAgent => ({ id: 'fake', label: 'Fake', lane: 'terminal', effective_lane: 'terminal', disabled: false, disabled_note: null, ...over });

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

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

const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const byText = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text);
const click = async (el: Element | null | undefined) => {
  expect(el, 'element to click').toBeTruthy();
  await act(async () => (el as HTMLElement).click());
};
const flush = async () => act(async () => void (await Promise.resolve()));

async function open(api: Parameters<typeof AddChatDialog>[0]['api'], onAdded = vi.fn(), onClose = vi.fn()) {
  await act(async () => root.render(<AddChatDialog agent={{ id: 'fake', label: 'Fake' }} api={api} onClose={onClose} onAdded={onAdded} />));
  await flush();
  return { onAdded, onClose };
}

const setField = async (id: string, value: string) =>
  act(async () => {
    const el = q<HTMLInputElement | HTMLTextAreaElement>(id)!;
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });

describe('AddChatDialog', () => {
  it('detects, picks the best guess and shows the confirm screen at once (nothing to type)', async () => {
    const overlayDetect = vi.fn(async () => ({
      ...detected,
      // the medium one comes first: the high one must still win
      candidates: [detected.candidates[1], detected.candidates[0]],
    }));
    const overlaySet = vi.fn(async () => row({ overlay: true }));
    const { onAdded } = await open({ overlayDetect, overlaySet });
    expect(overlayDetect).toHaveBeenCalledWith('fake');
    expect(overlayDetect).toHaveBeenCalledTimes(1);
    expect(q('[data-testid="add-chat-confirm"]')).toBeTruthy();
    expect(q('[data-testid="acp-step"]')).toBeNull();
    expect(q('[data-testid="add-chat-command"]')?.textContent).toBe('fake-agent acp --quiet');
    expect(q('[data-testid="add-chat-summary"]')?.textContent).toBe('Fake will start fake-agent acp --quiet for chat.');
    expect(document.body.textContent).toContain(confirmSentence('Fake'));
    expect(overlaySet).not.toHaveBeenCalled();
    await click(byText('Add chat'));
    expect(overlaySet).toHaveBeenCalledWith('fake', { command: 'fake-agent', args: ['acp', '--quiet'], env_allow: [] }, true);
    expect(onAdded).toHaveBeenCalledTimes(1);
  });

  it('Change details opens the form pre-filled with the guess and Review comes back to confirm', async () => {
    const overlaySet = vi.fn(async () => row());
    await open({ overlayDetect: async () => detected, overlaySet });
    await click(q('[data-testid="add-chat-change"]'));
    expect(q('[data-testid="acp-step"]')).toBeTruthy();
    expect(q<HTMLInputElement>('#acp-command')?.value).toBe('fake-agent');
    expect(q<HTMLTextAreaElement>('#acp-args')?.value).toBe('acp\n--quiet');
    expect(q('[data-testid="add-chat-note"]')).toBeNull();
    await setField('#acp-args', 'serve\n--acp');
    await click(byText('Review'));
    expect(q('[data-testid="add-chat-command"]')?.textContent).toBe('fake-agent serve --acp');
    await click(byText('Add chat'));
    expect(overlaySet).toHaveBeenCalledWith('fake', { command: 'fake-agent', args: ['serve', '--acp'], env_allow: [] }, true);
  });

  it('finding nothing says so plainly and shows the form; a typed command works', async () => {
    const overlaySet = vi.fn(async () => row());
    await open({ overlayDetect: async () => ({ ok: true, command: 'x', candidates: [] }), overlaySet });
    expect(q('[data-testid="add-chat-confirm"]')).toBeNull();
    expect(q('[data-testid="add-chat-note"]')?.textContent).toBe('Could not find how Fake offers chat. You can type it in.');
    expect(q('[data-testid="acp-step"]')).toBeTruthy();
    await setField('#acp-command', 'my-agent');
    await setField('#acp-args', 'serve\n--acp');
    await setField('#acp-env', 'MY_KEY');
    await click(byText('Review'));
    expect(commandLine({ command: 'my-agent', args: ['serve', '--acp'], env_allow: [] })).toBe('my-agent serve --acp');
    await click(byText('Add chat'));
    expect(overlaySet).toHaveBeenCalledWith('fake', { command: 'my-agent', args: ['serve', '--acp'], env_allow: ['MY_KEY'] }, true);
  });

  it('a failed look-up shows the message and the form', async () => {
    await open({ overlayDetect: async () => Promise.reject(new Error('WIZARD_NOT_FOUND: `fake` was not found on PATH.')), overlaySet: vi.fn() });
    expect(q('[data-testid="add-chat-reading"]')).toBeNull();
    expect(q('[data-testid="add-chat-note"]')?.textContent).toContain('Could not find how Fake offers chat. You can type it in.');
    expect(q('[data-testid="acp-step"]')).toBeTruthy();
  });

  it('gives up after 20 seconds so "Reading the help text..." can never hang', async () => {
    vi.useFakeTimers();
    try {
      const overlayDetect = vi.fn(() => new Promise<OverlayDetect>(() => {}));
      await open({ overlayDetect, overlaySet: vi.fn() });
      expect(q('[data-testid="add-chat-reading"]')).toBeTruthy();
      await act(async () => void (await vi.advanceTimersByTimeAsync(DETECT_TIMEOUT_MS - 1)));
      expect(q('[data-testid="add-chat-reading"]')).toBeTruthy();
      await act(async () => void (await vi.advanceTimersByTimeAsync(2)));
      expect(q('[data-testid="add-chat-reading"]')).toBeNull();
      expect(q('[data-testid="add-chat-note"]')?.textContent).toContain('You can type it in.');
      expect(q('[data-testid="acp-step"]')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the backend error text and stays open when it refuses', async () => {
    const overlaySet = vi.fn(async () => {
      throw new Error('ACP_OVERLAY_REFUSED: That program is a shell, which is not allowed.');
    });
    const { onAdded } = await open({ overlayDetect: async () => detected, overlaySet });
    await click(byText('Add chat'));
    expect(q('[data-testid="add-chat-error"]')?.textContent).toBe('That program is a shell, which is not allowed.');
    expect(onAdded).not.toHaveBeenCalled();
    expect(byText('Add chat')?.disabled).toBe(false);
  });

  it('Cancel on the confirm screen closes without saving', async () => {
    const overlaySet = vi.fn();
    const { onClose } = await open({ overlayDetect: async () => detected, overlaySet });
    await click(byText('Cancel'));
    expect(onClose).toHaveBeenCalled();
    expect(overlaySet).not.toHaveBeenCalled();
  });
});

const nativeOpt = (over: Partial<OverlayOption> = {}): OverlayOption => ({
  kind: 'native',
  label: 'fake on this computer',
  summary: 'The program you already have starts chat itself.',
  command_line: 'fake-agent acp',
  acp: { command: 'fake-agent', args: ['acp'], env_allow: [] },
  available: true,
  ...over,
});
const registryOpt = (over: Partial<OverlayOption> = {}): OverlayOption => ({
  kind: 'registry',
  label: 'Fake Adapter 1.2.3',
  summary: 'An adapter that speaks ACP.',
  registry: { id: 'fake-acp', name: 'Fake Adapter', version: '1.2.3', authors: ['Alice', 'Bob'], license: 'MIT', repository: 'https://example.test/fake', distribution: 'npx', size_hint: '40 MB' },
  available: true,
  ...over,
});
const bridgeOpt = (): OverlayOption => ({ kind: 'bridge', label: 'Chat made by Potato Workspace', summary: 'Potato Workspace makes a chat adapter.', available: false, reason: 'Fake has no non-interactive mode, so a chat adapter cannot be made' });
const bridgeOn = (hasMemory: boolean): OverlayOption => ({ kind: 'bridge', label: 'Chat made by Potato Workspace', summary: 'Potato Workspace will make a chat adapter for Fake.', bridge: { has_memory: hasMemory }, available: true });
const resolved = (...options: OverlayOption[]) => vi.fn(async () => ({ ok: true, options }));

describe('AddChatDialog with the app resolving the best way (native, registry, bridge)', () => {
  it('a program that starts chat itself: one confirm screen, saved with overlaySet, no detect call', async () => {
    const overlayResolve = resolved(nativeOpt(), bridgeOpt());
    const overlayDetect = vi.fn();
    const overlaySet = vi.fn(async () => row({ overlay: true }));
    const { onAdded } = await open({ overlayResolve, overlayDetect, overlaySet });
    expect(overlayResolve).toHaveBeenCalledTimes(1);
    expect(overlayDetect).not.toHaveBeenCalled();
    expect(q('[data-testid="add-chat-options"]')).toBeNull(); // one usable way: no choice to make
    expect(q('[data-testid="add-chat-summary"]')?.textContent).toBe('Fake will start fake-agent acp for chat.');
    await click(byText('Add chat'));
    expect(overlaySet).toHaveBeenCalledWith('fake', { command: 'fake-agent', args: ['acp'], env_allow: [] }, true);
    expect(onAdded).toHaveBeenCalledTimes(1);
  });

  it('shows the ACP check result on the confirm screen: passed, failed, or not checked for help-only', async () => {
    const base = { overlayDetect: vi.fn(), overlaySet: vi.fn(async () => row({ overlay: true })) };
    const passed = resolved(nativeOpt({ initialize_check: { ok: true, protocol_version: 1, agent_name: 'fake-acp', agent_version: '1.0' } }), bridgeOpt());
    await open({ ...base, overlayResolve: passed });
    expect(q('[data-testid="add-chat-check"]')?.textContent).toBe('ACP check passed (protocol 1)');
    await act(async () => root.unmount());
    root = createRoot(host);
    const failed = resolved(nativeOpt({ initialize_check: { ok: false, reason: 'no reply in 8 s' } }), bridgeOpt());
    await open({ ...base, overlayResolve: failed });
    expect(q('[data-testid="add-chat-check"]')?.textContent).toBe('ACP check failed: no reply in 8 s');
    await act(async () => root.unmount());
    root = createRoot(host);
    const helpOnly = resolved(nativeOpt(), bridgeOpt());
    await open({ ...base, overlayResolve: helpOnly });
    expect(q('[data-testid="add-chat-check"]')?.textContent).toBe('Not checked: this comes from the help text only.');
    expect(document.body.textContent).not.toContain('ACP check passed');
  });

  it('a registry adapter: says who made it and what happens, downloads with progress, then shows success', async () => {
    const overlayResolve = resolved(registryOpt(), bridgeOpt());
    let report: (p: OverlayProgress) => void = () => {};
    const stop = vi.fn();
    const overlayProgress = vi.fn(async (_agent: string, cb: (p: OverlayProgress) => void) => {
      report = cb;
      return stop;
    });
    let finish: () => void = () => {};
    const overlayInstall = vi.fn(() => new Promise<unknown>((resolve) => (finish = () => resolve({}))));
    const overlaySet = vi.fn();
    const { onAdded } = await open({ overlayResolve, overlayDetect: vi.fn(), overlaySet, overlayInstall, overlayProgress });
    const text = q('[data-testid="add-chat-summary"]')?.textContent;
    expect(text).toBe('Potato Workspace will download Fake Adapter 1.2.3 by Alice, Bob (MIT) from the official ACP registry and run it for chat. About 40 MB.');
    expect(q('[data-testid="add-chat-registry-about"]')?.textContent).toBe('An adapter that speaks ACP.');
    expect(overlayInstall).not.toHaveBeenCalled();
    await click(byText('Add chat'));
    expect(overlayInstall).toHaveBeenCalledWith('fake', { kind: 'registry', id: 'fake-acp', version: '1.2.3' }, true);
    expect(q('[data-testid="add-chat-installing"]')).toBeTruthy();
    expect(byText('Cancel')).toBeUndefined();
    await act(async () => report({ state: 'installing', lines: ['Downloading Fake Adapter 1.2.3...', 'added 1 package'], detail: '' }));
    expect(q('[data-testid="add-chat-progress"]')?.textContent).toContain('added 1 package');
    await act(async () => finish());
    await flush();
    expect(q('[data-testid="add-chat-success"]')?.textContent).toBe('Fake Adapter 1.2.3 is ready. Chat is added for Fake.');
    expect(stop).toHaveBeenCalled();
    expect(overlaySet).not.toHaveBeenCalled();
    expect(onAdded).not.toHaveBeenCalled();
    await click(byText('Done'));
    expect(onAdded).toHaveBeenCalledWith(null);
  });

  it('registry text is shown as plain text, never as markup', async () => {
    const evil = registryOpt({ summary: '<img src=x onerror=alert(1)>', registry: { ...registryOpt().registry!, name: '<b>Bold</b>', authors: ['<i>x</i>'] } });
    await open({ overlayResolve: resolved(evil), overlaySet: vi.fn(), overlayInstall: vi.fn() });
    expect(document.querySelector('[data-testid="add-chat-dialog"] img, [data-testid="add-chat-dialog"] b, [data-testid="add-chat-dialog"] i')).toBeNull();
    expect(q('[data-testid="add-chat-summary"]')?.textContent).toContain('<b>Bold</b>');
  });

  it('two usable ways are radio choices, best first; an unavailable bridge is never one', async () => {
    const overlayResolve = resolved(nativeOpt(), registryOpt(), bridgeOpt());
    const overlaySet = vi.fn(async () => row());
    const overlayInstall = vi.fn(async () => ({}));
    await open({ overlayResolve, overlaySet, overlayInstall });
    const radios = [...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios).toHaveLength(2);
    expect(radios.map((r) => r.checked)).toEqual([true, false]);
    expect(q('[data-testid="add-chat-command"]')?.textContent).toBe('fake-agent acp');
    await click(radios[1]);
    expect(q('[data-testid="add-chat-summary"]')?.textContent).toContain('will download Fake Adapter 1.2.3');
    await click(radios[0]);
    await click(byText('Add chat'));
    expect(overlaySet).toHaveBeenCalledTimes(1);
    expect(overlayInstall).not.toHaveBeenCalled();
  });

  it('the bridge is the last resort: alone it is the confirm screen, with the honest sentence, and saves with kind bridge', async () => {
    const overlayInstall = vi.fn(async () => row({ overlay: true }));
    const overlaySet = vi.fn();
    const { onAdded } = await open({ overlayResolve: resolved(nativeOpt({ available: false, reason: 'no' }), bridgeOn(true)), overlaySet, overlayInstall });
    expect(q('[data-testid="add-chat-options"]')).toBeNull();
    expect(q('[data-testid="add-chat-summary"]')?.textContent).toBe(
      'Fake has no chat support of its own, so Potato Workspace will make one. It talks to Fake one message at a time: text only, no tool cards, it remembers the conversation.',
    );
    await click(byText('Add chat'));
    await flush();
    expect(overlayInstall).toHaveBeenCalledWith('fake', { kind: 'bridge' }, true);
    expect(overlaySet).not.toHaveBeenCalled();
    expect(onAdded).toHaveBeenCalledTimes(1);
  });

  it('the bridge says plainly when the agent does not remember earlier messages, and a failure keeps the screen', async () => {
    const overlayInstall = vi.fn().mockRejectedValueOnce(new Error('NOT_AVAILABLE: Fake has no non-interactive mode, so a chat adapter cannot be made'));
    await open({ overlayResolve: resolved(bridgeOn(false)), overlaySet: vi.fn(), overlayInstall });
    expect(q('[data-testid="add-chat-summary"]')?.textContent).toContain('text only, no tool cards, it does not remember earlier messages.');
    await click(byText('Add chat'));
    await flush();
    expect(q('[data-testid="add-chat-error"]')?.textContent).toContain('cannot be made');
    expect(q('[data-testid="add-chat-confirm"]')).toBeTruthy();
    expect(byText('Add chat')?.disabled).toBe(false);
  });

  it('a better way stays first and the bridge is the last radio', async () => {
    const overlayInstall = vi.fn(async () => row({ overlay: true }));
    await open({ overlayResolve: resolved(nativeOpt(), bridgeOn(true)), overlaySet: vi.fn(), overlayInstall });
    const radios = [...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios.map((r) => r.checked)).toEqual([true, false]);
    await click(radios[1]);
    expect(q('[data-testid="add-chat-summary"]')?.textContent).toContain('so Potato Workspace will make one');
    await click(byText('Add chat'));
    await flush();
    expect(overlayInstall).toHaveBeenCalledWith('fake', { kind: 'bridge' }, true);
  });

  it('the first usable way is preselected even when an unusable one is listed first', async () => {
    await open({ overlayResolve: resolved(nativeOpt({ available: false, reason: 'Its help does not show a chat (ACP) command.' }), registryOpt(), bridgeOpt()), overlaySet: vi.fn(), overlayInstall: vi.fn() });
    expect(q('[data-testid="add-chat-summary"]')?.textContent).toContain('will download');
    expect(q('[data-testid="add-chat-options"]')).toBeNull();
  });

  it('a failed download shows the sentence, stays on the confirm screen and can be tried again', async () => {
    const overlayInstall = vi.fn().mockRejectedValueOnce(new Error('ACP_ADDON_FAILED: The download failed: could not reach the server.')).mockResolvedValueOnce({});
    await open({ overlayResolve: resolved(registryOpt()), overlaySet: vi.fn(), overlayInstall });
    await click(byText('Add chat'));
    await flush();
    expect(q('[data-testid="add-chat-error"]')?.textContent).toBe('The download failed: could not reach the server.');
    expect(q('[data-testid="add-chat-confirm"]')).toBeTruthy();
    expect(byText('Add chat')?.disabled).toBe(false);
    await click(byText('Add chat'));
    await flush();
    expect(q('[data-testid="add-chat-success"]')).toBeTruthy();
    expect(q('[data-testid="add-chat-error"]')).toBeNull();
  });

  it('nothing usable: says why, shows the form, and a typed command still works', async () => {
    const overlaySet = vi.fn(async () => row());
    await open({ overlayResolve: resolved(nativeOpt({ available: false, reason: 'Its help does not show a chat (ACP) command.' }), bridgeOpt()), overlaySet });
    expect(q('[data-testid="add-chat-confirm"]')).toBeNull();
    expect(q('[data-testid="add-chat-note"]')?.textContent).toBe('Could not find how Fake offers chat. You can type it in. Its help does not show a chat (ACP) command.');
    await setField('#acp-command', 'my-agent');
    await setField('#acp-args', 'serve');
    await click(byText('Review'));
    await click(byText('Add chat'));
    expect(overlaySet).toHaveBeenCalledWith('fake', { command: 'my-agent', args: ['serve'], env_allow: [] }, true);
  });

  it('Change details on a native way pre-fills the form; on a download it starts blank', async () => {
    await open({ overlayResolve: resolved(nativeOpt()), overlaySet: vi.fn() });
    await click(q('[data-testid="add-chat-change"]'));
    expect(q<HTMLInputElement>('#acp-command')?.value).toBe('fake-agent');
    expect(q<HTMLTextAreaElement>('#acp-args')?.value).toBe('acp');
    await act(async () => root.render(<div />));
    await open({ overlayResolve: resolved(registryOpt()), overlaySet: vi.fn(), overlayInstall: vi.fn() });
    await click(q('[data-testid="add-chat-change"]'));
    expect(q<HTMLInputElement>('#acp-command')?.value).toBe('');
  });

  it('an app whose resolve fails falls back to reading the help text', async () => {
    const overlayResolve = vi.fn(async () => Promise.reject(new Error('unknown command acp_overlay_resolve')));
    const overlayDetect = vi.fn(async () => detected);
    const overlaySet = vi.fn(async () => row());
    await open({ overlayResolve, overlayDetect, overlaySet });
    expect(overlayDetect).toHaveBeenCalledWith('fake');
    expect(q('[data-testid="add-chat-command"]')?.textContent).toBe('fake-agent acp --quiet');
    await click(byText('Add chat'));
    expect(overlaySet).toHaveBeenCalledWith('fake', { command: 'fake-agent', args: ['acp', '--quiet'], env_allow: [] }, true);
  });

  it('Cancel on a download confirm closes without installing', async () => {
    const overlayInstall = vi.fn();
    const { onClose } = await open({ overlayResolve: resolved(registryOpt()), overlaySet: vi.fn(), overlayInstall });
    await click(byText('Cancel'));
    expect(onClose).toHaveBeenCalled();
    expect(overlayInstall).not.toHaveBeenCalled();
  });
});

describe('overlay option helpers', () => {
  it('writes the confirm sentence with and without optional parts', () => {
    const info = registryOpt().registry!;
    expect(registrySentence(info)).toBe('Potato Workspace will download Fake Adapter 1.2.3 by Alice, Bob (MIT) from the official ACP registry and run it for chat. About 40 MB.');
    expect(registrySentence({ ...info, authors: [], license: '', size_hint: null })).toBe('Potato Workspace will download Fake Adapter 1.2.3 from the official ACP registry and run it for chat.');
    expect(authorsText(['A', 'B', 'C', 'D'])).toBe('A, B, C and others');
  });

  it('picks the first usable option and drops unknown kinds', () => {
    expect(firstAvailable([nativeOpt({ available: false }), registryOpt(), bridgeOpt()])).toBe(1);
    expect(firstAvailable([bridgeOpt()])).toBe(-1);
    expect(firstAvailable(null)).toBe(-1);
    const list = normalizeOptions({ ok: true, options: [registryOpt(), { kind: 'mystery', label: 'x', summary: '', available: true } as unknown as OverlayOption] });
    expect(list.map((o) => o.kind)).toEqual(['registry']);
    expect(normalizeOptions(null)).toEqual([]);
  });
});

describe('lane view parsing', () => {
  it('defaults the new fields for an old backend', () => {
    const v = normalizeLaneView({ labs_enabled: true, agents: [row()] });
    expect(v.can_add_chat).toEqual([]);
    expect(addableChat(v)).toEqual([]);
    expect(addableChat({ labs_enabled: false, agents: [], can_add_chat: [{ id: 'a', label: 'A' }] })).toEqual([]);
  });
});

describe('Settings How to run rows', () => {
  const view = (): AcpLaneView => ({
    labs_enabled: true,
    agents: [row({ id: 'mine', label: 'Mine', overlay: true })],
    can_add_chat: [
      { id: 'fake', label: 'Fake' },
      { id: 'blocked', label: 'Blocked', reason: 'It has no help text to read.' },
    ],
  });

  it('add button opens the dialog; a success refreshes the list', async () => {
    let calls = 0;
    const laneGet = vi.fn(async () => (calls++ === 0 ? view() : { labs_enabled: true, agents: [row({ id: 'fake', overlay: true })], can_add_chat: [] }));
    const overlaySet = vi.fn(async () => row({ overlay: true }));
    await act(async () => root.render(<AgentLaneRows api={{ laneGet, laneSet: vi.fn(), overlayDetect: async () => detected, overlaySet, overlayRemove: vi.fn() }} />));
    await flush();
    const blocked = document.querySelector<HTMLButtonElement>('[aria-label="Add chat (ACP) for Blocked"]');
    expect(blocked?.disabled).toBe(true);
    expect(document.body.textContent).toContain('It has no help text to read.');
    await click(document.querySelector('[aria-label="Add chat (ACP) for Fake"]'));
    await flush();
    await click(byText('Add chat'));
    await flush();
    expect(overlaySet).toHaveBeenCalledWith('fake', expect.anything(), true);
    expect(laneGet).toHaveBeenCalledTimes(2);
    expect(q('[data-testid="add-chat-dialog"]')).toBeNull();
    expect(document.querySelector('[aria-label="Add chat (ACP) for Fake"]')).toBeNull();
  });

  it('Remove chat shows on every agent with a chat, asks first, and an older app removes only an added chat', async () => {
    const overlayRemove = vi.fn(async () => undefined);
    const laneGet = vi.fn(async () => view());
    await act(async () => root.render(<AgentLaneRows api={{ laneGet, laneSet: vi.fn(), overlayRemove }} />));
    await flush();
    expect(document.querySelectorAll('[aria-label^="Remove chat for"]').length).toBeGreaterThan(0);
    await click(document.querySelector('[aria-label="Remove chat for Mine"]'));
    expect(overlayRemove).not.toHaveBeenCalled();
    await click(byText('Remove'));
    await flush();
    expect(overlayRemove).toHaveBeenCalledWith('mine');
    expect(laneGet).toHaveBeenCalledTimes(2);
  });
});

describe('the + menu hint', () => {
  const accounts = { list: async () => ({ agents: [], accounts: [] }) } as unknown as AccountsApi;
  const entries = [
    { type: 'fake', label: 'Fake' },
    { type: 'other', label: 'Other' },
  ];
  async function menu(chat: Partial<NonNullable<Parameters<typeof NewAgentMenu>[0]['chat']>> & { agents: never[]; onStart: () => Promise<void> } | undefined) {
    await act(async () => root.render(<NewAgentMenu entries={entries} readyAgents={new Set()} onStart={vi.fn()} onClose={vi.fn()} accountsApi={accounts} chat={chat && { mode: 'chat', onMode: vi.fn(), ...chat }} />));
  }

  it('shows one "Set up chat" link when an agent can be added', async () => {
    const setupLink = () => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Set up chat for another agent…');
    const add = { id: 'fake', label: 'Fake' };
    await menu({ agents: [], onStart: vi.fn(async () => undefined), canAdd: [add], onAddChat: vi.fn() });
    expect(setupLink()).toBeDefined();
  });

  it('shows no link when nothing can be added (Labs off sends an empty list)', async () => {
    const setupLink = () => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Set up chat for another agent…');
    await menu({
      agents: [],
      onStart: vi.fn(async () => undefined),
      canAdd: addableChat({ labs_enabled: false, agents: [], can_add_chat: [{ id: 'fake', label: 'Fake' }] }),
    });
    expect(setupLink()).toBeUndefined();
    await menu(undefined);
    expect(setupLink()).toBeUndefined();
  });
});

describe('AddChatDialog with Chat (terminal)', () => {
  const termSummary = 'Potato Workspace runs Fake in a terminal and shows it as a chat. You get its tool cards and history, and you can answer its questions here. It cannot resume old sessions.';
  const termOpt = (over: Partial<OverlayOption> = {}): OverlayOption => ({
    kind: 'terminal_chat',
    label: 'Chat (terminal)',
    summary: termSummary,
    terminal_chat: { reads_file: true, can_resume: false, can_answer_prompts: true, note: '' },
    available: true,
    ...over,
  });

  it('is kept by normalizeOptions and ranked after native and registry, before the bridge', () => {
    const list = normalizeOptions({ ok: true, options: [bridgeOpt(), termOpt(), registryOpt()] });
    expect(list.map((o) => o.kind)).toEqual(['bridge', 'terminal_chat', 'registry']);
    expect(firstAvailable([nativeOpt({ available: false }), termOpt(), bridgeOpt()])).toBe(1);
  });

  it('alone it is the confirm screen with its summary and "Nothing to download.", no command box, no ACP word', async () => {
    await open({ overlayResolve: resolved(termOpt()), overlaySet: vi.fn(async () => row()), overlayInstall: vi.fn(async () => ({})) });
    expect(q('[data-testid="add-chat-summary"]')?.textContent).toBe(termSummary);
    expect(q('[data-testid="add-chat-command"]')).toBeNull();
    expect(document.body.textContent).toContain('Nothing to download.');
    expect(document.querySelector('[data-testid="add-chat-dialog"]')?.textContent).not.toMatch(/ACP/);
  });

  it('is a radio with its label and summary when another route is also usable, and is preselected when first', async () => {
    await open({ overlayResolve: resolved(termOpt(), registryOpt()), overlaySet: vi.fn(async () => row()), overlayInstall: vi.fn(async () => ({})) });
    const radios = [...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios).toHaveLength(2);
    expect(radios.map((r) => r.checked)).toEqual([true, false]);
    const termRadio = q('[data-testid="add-chat-option-terminal_chat"]')!;
    expect(termRadio.textContent).toContain('Chat (terminal)');
    expect(termRadio.textContent).toContain(termSummary);
    expect(termRadio.textContent).toContain('Nothing to download.');
    expect(termRadio.textContent).not.toMatch(/ACP/);
  });

  it('is not preselected when a native program comes first', async () => {
    await open({ overlayResolve: resolved(nativeOpt(), termOpt()), overlaySet: vi.fn(async () => row()), overlayInstall: vi.fn(async () => ({})) });
    const radios = [...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios.map((r) => r.checked)).toEqual([true, false]);
  });

  it('Add chat calls install with {kind:"terminal_chat"} and confirmed true, never overlaySet, and reports the row', async () => {
    const overlayInstall = vi.fn(async () => row({ lane: 'terminal_chat' as never }));
    const overlaySet = vi.fn(async () => row());
    const { onAdded } = await open({ overlayResolve: resolved(termOpt()), overlaySet, overlayInstall });
    await click(byText('Add chat'));
    await flush();
    expect(overlayInstall).toHaveBeenCalledWith('fake', { kind: 'terminal_chat' }, true);
    expect(overlaySet).not.toHaveBeenCalled();
    expect(onAdded).toHaveBeenCalledTimes(1);
  });

  it('a refusal shows the backend text and keeps the dialog open', async () => {
    const overlayInstall = vi.fn(async () => {
      throw new Error('Turn on Labs first.');
    });
    const { onAdded } = await open({ overlayResolve: resolved(termOpt()), overlayInstall });
    await click(byText('Add chat'));
    await flush();
    expect(q('[data-testid="add-chat-error"]')?.textContent).toContain('Turn on Labs first.');
    expect(onAdded).not.toHaveBeenCalled();
  });

  it('other routes are unchanged: a native program still saves with overlaySet, not install', async () => {
    const overlaySet = vi.fn(async () => row());
    const overlayInstall = vi.fn(async () => ({}));
    await open({ overlayResolve: resolved(nativeOpt(), termOpt()), overlaySet, overlayInstall });
    await click(byText('Add chat'));
    await flush();
    expect(overlaySet).toHaveBeenCalledWith('fake', expect.objectContaining({ command: 'fake-agent' }), true);
    expect(overlayInstall).not.toHaveBeenCalled();
  });
});

// ---- a reviewed adapter (fakeagent only): the key gate, saving a key, the install call and the version note ----

const adapterOption = (over: Record<string, unknown> = {}): OverlayOption =>
  ({
    kind: 'adapter',
    label: 'Reviewed adapter',
    summary: 'Potato Workspace runs a reviewed adapter script.',
    available: true,
    adapter: { id: 'fakeagent', tested_version: '1.0.0' },
    env_keys: [{ env: 'FAKEAGENT_TOKEN', label: 'Token' }],
    env_settings: [
      {
        env: 'FAKEAGENT_MODEL',
        label: 'Model',
        default: 'fake/model-small',
        options: [
          { value: 'fake/model-small', label: 'Small (token key)', needs_key: 'FAKEAGENT_TOKEN' },
          { value: 'fake/model-other', label: 'Other (token key)', needs_key: 'FAKEAGENT_TOKEN' },
        ],
      },
    ],
    key_groups: [['FAKEAGENT_TOKEN']],
    installed_version: '1.0.0',
    ...over,
  }) as unknown as OverlayOption;

/** An api whose key status reads what was saved, so saving a key changes what the screen shows. */
function adapterApi(option: OverlayOption = adapterOption()) {
  const saved = new Set<string>();
  return {
    overlayDetect: vi.fn(async () => detected),
    overlaySet: vi.fn(),
    overlayResolve: vi.fn(async () => ({ ok: true, options: [option] })),
    overlayInstall: vi.fn(async () => row()),
    adapterKeyStatus: vi.fn(async () => [{ env: 'FAKEAGENT_TOKEN', label: 'Token', set: saved.has('FAKEAGENT_TOKEN'), shared: false }]),
    adapterKeySet: vi.fn(async (_id: string, env: string) => {
      saved.add(env);
    }),
  };
}

describe('AddChatDialog: a reviewed adapter option', () => {
  it('a missing key blocks Add chat until it is saved, and saving it enables Add chat', async () => {
    const api = adapterApi();
    await open(api);
    await flush();
    await flush();
    expect(q('[data-testid="adapter-missing"]')?.textContent).toContain('Save a key first: Token');
    expect(byText('Add chat')?.disabled).toBe(true);
    await setField('[data-testid="adapter-key-input-FAKEAGENT_TOKEN"]', 'fake-token-value-0001');
    await click(q('[data-testid="adapter-key-save-FAKEAGENT_TOKEN"]'));
    await flush();
    await flush();
    expect(api.adapterKeySet).toHaveBeenCalledWith('fakeagent', 'FAKEAGENT_TOKEN', 'fake-token-value-0001');
    expect(q('[data-testid="adapter-missing"]')).toBeNull();
    expect(byText('Add chat')?.disabled).toBe(false);
  });

  it('the install call carries approved names and plain settings only, never the key value', async () => {
    const api = adapterApi();
    const { onAdded } = await open(api);
    await flush();
    await setField('[data-testid="adapter-key-input-FAKEAGENT_TOKEN"]', 'fake-token-value-0001');
    await click(q('[data-testid="adapter-key-save-FAKEAGENT_TOKEN"]'));
    await flush();
    await flush();
    expect(q<HTMLInputElement>('[data-testid="adapter-setting-FAKEAGENT_MODEL"]')?.value).toBe('fake/model-small');
    await click(byText('Add chat'));
    await flush();
    await flush();
    expect(api.overlayInstall).toHaveBeenCalledWith('fake', { kind: 'adapter', approved_keys: ['FAKEAGENT_TOKEN'], settings: { FAKEAGENT_MODEL: 'fake/model-small' } }, true);
    expect(JSON.stringify(api.overlayInstall.mock.calls)).not.toContain('fake-token-value-0001');
    expect(onAdded).toHaveBeenCalled();
  });

  it('a key kept in Keys settings is only pointed at, and Add chat stays disabled', async () => {
    const api = adapterApi();
    api.adapterKeyStatus.mockResolvedValue([{ env: 'FAKEAGENT_TOKEN', label: 'Token', set: false, shared: true }]);
    await open(api);
    await flush();
    await flush();
    expect(q('[data-testid="adapter-key-FAKEAGENT_TOKEN"]')?.textContent).toContain('Keys settings');
    expect(q('[data-testid="adapter-key-input-FAKEAGENT_TOKEN"]')).toBeNull();
    expect(byText('Add chat')?.disabled).toBe(true);
  });

  it('says when this computer has another version than the adapter was tested on', async () => {
    const api = adapterApi(adapterOption({ installed_version: '2.3.0' }));
    await open(api);
    await flush();
    await flush();
    expect(q('[data-testid="add-chat-summary"]')?.textContent).toContain('tested on version 1.0.0');
    expect(q('[data-testid="add-chat-version-note"]')?.textContent).toContain('2.3.0');
  });

  it('shows no version note when the versions match', async () => {
    const api = adapterApi();
    await open(api);
    await flush();
    await flush();
    expect(q('[data-testid="add-chat-version-note"]')).toBeNull();
  });
});

// ---- adapter health (fakeagent only): the note on a passing adapter, the plain reason when it is blocked ----

describe('AddChatDialog: adapter health', () => {
  it('shows the health note when the last check passed on a version the adapter was not tested on', async () => {
    const api = adapterApi(adapterOption({ note: 'Not tested on version 2.3.0' }));
    await open(api);
    await flush();
    await flush();
    expect(q('[data-testid="add-chat-health-note"]')?.textContent).toContain('Not tested on version 2.3.0');
  });

  it('a blocked adapter says why in plain words, offers no Add chat, and the terminal is not named as off', async () => {
    const reason = 'Fake updated to 2.3.0 and its chat adapter no longer starts (it did not answer the start-up check). The terminal still works.';
    const api = adapterApi(adapterOption({ available: false, reason }));
    await open(api);
    await flush();
    await flush();
    expect(q('[data-testid="add-chat-note"]')?.textContent).toContain('The terminal still works.');
    expect(byText('Add chat')?.disabled ?? true).toBe(true);
  });
});

describe('AddChatDialog: the adapter model picker', () => {
  it('shows choices and a free text box, preselects the first choice whose key is saved, and installs the typed value', async () => {
    const api = adapterApi();
    await open(api);
    await flush();
    await flush();
    const pick = q<HTMLSelectElement>('[data-testid="adapter-setting-pick-FAKEAGENT_MODEL"]');
    expect(pick).toBeTruthy();
    // Key not saved yet: the choice is still listed, marked as needing its key, and nothing is preselected to it.
    expect(pick?.textContent).toContain('needs FAKEAGENT_TOKEN saved');
    await setField('[data-testid="adapter-key-input-FAKEAGENT_TOKEN"]', 'fake-token-value-0002');
    await click(q('[data-testid="adapter-key-save-FAKEAGENT_TOKEN"]'));
    await flush();
    await flush();
    expect(q<HTMLInputElement>('[data-testid="adapter-setting-FAKEAGENT_MODEL"]')?.value).toBe('fake/model-small');
    await setField('[data-testid="adapter-setting-FAKEAGENT_MODEL"]', 'fake/typed-model');
    await click(byText('Add chat'));
    await flush();
    await flush();
    expect(api.overlayInstall).toHaveBeenCalledWith('fake', expect.objectContaining({ kind: 'adapter', settings: { FAKEAGENT_MODEL: 'fake/typed-model' } }), true);
  });
});

// ---- the real path: the real api object, with only the Tauri `invoke` replaced by what the backend really returns ----

/** The `acp_overlay_resolve` answer of the Rust command for a bundled agent whose adapter is shipped (a real run's JSON,
 * with the agent renamed): the adapter first, the program's own help, the bridge. Plain `options` array inside `{ok}`. */
const realResolve = (adapterAvailable: boolean) => ({
  ok: true,
  options: [
    {
      kind: 'adapter',
      label: 'Reviewed adapter',
      summary: 'Potato Workspace runs a reviewed adapter script with the Python that fakeagent was installed with. Tested with fakeagent 1.0.0.',
      adapter: { id: 'fakeagent', tested_version: '1.0.0' },
      env_keys: [{ env: 'FAKEAGENT_TOKEN', label: 'Token' }],
      env_settings: [{ env: 'FAKEAGENT_MODEL', label: 'Model', default: 'fake/model-small', options: [{ value: 'fake/model-small', label: 'Small', needs_key: 'FAKEAGENT_TOKEN' }] }],
      key_groups: [['FAKEAGENT_TOKEN']],
      installed_version: '1.0.0',
      available: adapterAvailable,
      ...(adapterAvailable ? {} : { reason: 'Could not find the Python that fakeagent was installed with, so the adapter cannot run.' }),
    },
    { kind: 'native', label: 'fakeagent on this computer', summary: 'The program you already have starts chat itself.', available: false, reason: 'Its help does not show a chat (ACP) command.' },
    { kind: 'bridge', label: 'Chat made by Potato Workspace', summary: "Potato Workspace makes a chat adapter from the agent's non-interactive mode.", available: false, reason: 'fakeagent has no non-interactive mode, so a chat adapter cannot be made' },
  ],
});

describe('AddChatDialog through the real api (invoke mocked with the backend answers)', () => {
  beforeEach(() => {
    (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
  });
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    vi.mocked(invoke).mockReset();
  });

  const backend = (resolve: unknown) =>
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'acp_overlay_resolve') return resolve;
      if (command === 'acp_adapter_key_status') return [{ env: 'FAKEAGENT_TOKEN', label: 'Token', set: false, shared: false }];
      throw new Error(`unexpected command ${command}`);
    });

  it('shows the adapter panel, not the manual form, when the backend lists an available adapter', async () => {
    backend(realResolve(true));
    await open(tauriAcpChatApi);
    await flush();
    await flush();
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('acp_overlay_resolve', { agent: 'fake' });
    expect(q('[data-testid="adapter-panel"]')).toBeTruthy();
    expect(q('[data-testid="adapter-missing"]')?.textContent).toContain('Save a key first: Token');
    expect(q('[data-testid="add-chat-confirm"]')).toBeTruthy();
    expect(document.body.textContent).not.toContain('Could not find how');
    expect(document.body.textContent).not.toContain('help does not show');
    expect(byText('Add chat')?.disabled).toBe(true);
  });

  it('when the adapter cannot run it says why (its own reason, not the help text) and shows the form', async () => {
    backend(realResolve(false));
    await open(tauriAcpChatApi);
    await flush();
    await flush();
    expect(q('[data-testid="adapter-panel"]')).toBeNull();
    expect(document.body.textContent).toContain('Could not find the Python that fakeagent was installed with');
    expect(document.body.textContent).not.toContain('help does not show');
  });
});
