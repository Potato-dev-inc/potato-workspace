// @vitest-environment jsdom
// The Add-an-agent result buttons are wired all the way: Settings > Agents row -> request -> the cockpit host -> a pane.
// Also "Found on this computer". The backend is faked at the Tauri boundary, so the real api wrapper is exercised.
import { invoke } from '@tauri-apps/api/core';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddAgentApi, AddAgentRun, FoundAgent } from '../../../lib/addAgent';
import { SCENARIOS, mockAddAgentApi } from '../../../lib/addAgent.mocks';
import { AddAgentActionHost } from '../../cockpit/AddAgentActionHost';
import { agentsRows } from '../sections/AgentsSection';
import { buttonByText, click, mountRows, settle, type as typeInto } from '../test-utils';
import { AddAgent } from './AddAgent';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => undefined), emit: vi.fn(async () => undefined) }));
vi.mock('../../../hooks/useProjectPath', () => ({ useProjectPath: () => ({ projectPath: 'C:/work/demo', setProjectPath: vi.fn(), ready: true }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const lastFrame = (name: string): AddAgentRun => SCENARIOS[name].frames.at(-1)!.run;
const FOUND: FoundAgent[] = [
  { id: 'fakenat', displayName: 'Fakenat', path: 'C:/bin/fakenat', kind: 'native', version: '1.2.0' },
  { id: 'faketerm', displayName: 'Faketerm', path: 'C:/bin/faketerm', kind: 'terminal' },
];

/** Answers the add_agent_* commands with the finished frame of one mock scenario. */
function fakeBackend(scenario: string, detect: () => Promise<unknown> = async () => []) {
  vi.mocked(invoke).mockImplementation((async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'add_agent_start') return { ...lastFrame(scenario), input: String(args?.input ?? '') };
    if (cmd === 'add_agent_status') return null;
    if (cmd === 'agents_detect_installed') return detect();
    return null;
  }) as never);
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.mocked(invoke).mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  globalThis.sessionStorage.clear();
});

const fakeCockpit = () => {
  const c = { newAgent: vi.fn(async (_id: string) => 'pane-terminal' as string | null), select: vi.fn(), notify: vi.fn() };
  const startChat = vi.fn(async (_id: string, _folder: string) => 'pane-chat');
  return { c, startChat };
};
const box = (m: { host: HTMLElement }) => m.host.querySelector('input[aria-label="Agent name"]') as HTMLInputElement;

/** The Settings row and the cockpit host side by side, as they are in the app. */
async function withHost(folder?: string | null) {
  const { c, startChat } = fakeCockpit();
  const m = await mountRows([agentsRows[0]]);
  const el = document.createElement('div');
  document.body.appendChild(el);
  const hostRoot = createRoot(el);
  await act(async () => hostRoot.render(<AddAgentActionHost c={c} startChat={startChat} folder={folder} />));
  const close = async () => {
    await act(async () => hostRoot.unmount());
    el.remove();
    await m.unmount();
  };
  return { c, startChat, m, close };
}

describe('Add an agent: result buttons reach a pane', () => {
  it('Start a chat in Settings starts a chat in the project folder and selects it', async () => {
    fakeBackend('native_ok');
    const w = await withHost();
    try {
      await typeInto(box(w.m), 'fakenat');
      await click(buttonByText(w.m.host, 'Add'));
      await settle();
      await click(buttonByText(w.m.host, 'Start a chat'));
      await settle();
      expect(w.startChat).toHaveBeenCalledWith('fakenat', 'C:/work/demo');
      expect(w.c.select).toHaveBeenCalledWith('pane-chat');
    } finally {
      await w.close();
    }
  });

  it('Open in a terminal opens the agent terminal pane and selects it', async () => {
    fakeBackend('native_ok');
    const w = await withHost();
    try {
      await typeInto(box(w.m), 'fakenat');
      await click(buttonByText(w.m.host, 'Add'));
      await settle();
      await click(buttonByText(w.m.host, 'Open in a terminal'));
      await settle();
      expect(w.c.newAgent).toHaveBeenCalledWith('fakenat');
      expect(w.c.select).toHaveBeenCalledWith('pane-terminal');
      expect(w.startChat).not.toHaveBeenCalled();
    } finally {
      await w.close();
    }
  });

  it('a terminal-only result opens its terminal, and "already added" opens the agent', async () => {
    fakeBackend('terminal_only');
    const w = await withHost();
    try {
      await typeInto(box(w.m), 'faketerm');
      await click(buttonByText(w.m.host, 'Add'));
      await settle();
      await click(buttonByText(w.m.host, 'Open Faketerm'));
      await settle();
      expect(w.c.newAgent).toHaveBeenCalledWith('faketerm');
      w.c.newAgent.mockClear();
      await click(buttonByText(w.m.host, 'Add another'));
      fakeBackend('already_added');
      await typeInto(box(w.m), 'fakenat');
      await click(buttonByText(w.m.host, 'Add'));
      await settle();
      await click(buttonByText(w.m.host, 'Open Fakenat'));
      await settle();
      expect(w.c.newAgent).toHaveBeenCalledWith('fakenat');
    } finally {
      await w.close();
    }
  });

  it('a chat that cannot start tells the person instead of doing nothing', async () => {
    fakeBackend('native_ok');
    const w = await withHost();
    try {
      w.startChat.mockRejectedValueOnce(new Error('Chat is turned off in Labs.'));
      await typeInto(box(w.m), 'fakenat');
      await click(buttonByText(w.m.host, 'Add'));
      await settle();
      await click(buttonByText(w.m.host, 'Start a chat'));
      await settle();
      expect(w.c.notify).toHaveBeenCalledTimes(1);
      expect(w.c.select).not.toHaveBeenCalled();
    } finally {
      await w.close();
    }
  });

  it('Show the install window opens the add-ons row of Settings', async () => {
    const opened: string[] = [];
    const { registerSettingsOpener } = await import('../../../lib/openSettingsAt');
    registerSettingsOpener((tab) => opened.push(tab));
    fakeBackend('install_failed');
    const m = await mountRows([agentsRows[0]]);
    try {
      await typeInto(box(m), 'fakereg');
      await click(buttonByText(m.host, 'Add'));
      await settle();
      await click(buttonByText(m.host, 'Show the install window'));
      expect(opened).toEqual(['chat-addons']);
    } finally {
      registerSettingsOpener(null);
      await m.unmount();
    }
  });

  it('Restart Potato is not drawn while the app has no restart call, and is drawn when given one', async () => {
    const run = lastFrame('install_failed');
    const failed: AddAgentRun = { ...run, error: { code: 'ADD_NOT_SEEN_AFTER_INSTALL', message: 'Fakereg is installed, but Potato cannot see it yet.', action: 'restart_app', step: null } };
    const api: AddAgentApi = { start: async () => failed, status: async () => failed, cancel: async () => failed, approveInstall: async () => failed, onProgress: async () => () => undefined };
    for (const withRestart of [false, true]) {
      const onRestartApp = vi.fn();
      await act(async () => root.render(<AddAgent api={api} onRestartApp={withRestart ? onRestartApp : undefined} />));
      await typeInto(box({ host }), 'fakereg');
      await click(buttonByText(host, 'Add'));
      await settle();
      const restart = buttonByText(host, 'Restart Potato');
      expect(Boolean(restart)).toBe(withRestart);
      if (restart) {
        await click(restart);
        expect(onRestartApp).toHaveBeenCalledTimes(1);
      }
      await act(async () => root.unmount());
      root = createRoot(host);
    }
  });
});

describe('Add an agent: Found on this computer', () => {
  const withDetect = (list: () => Promise<FoundAgent[]>): AddAgentApi => ({ ...mockAddAgentApi('native_ok'), detectInstalled: vi.fn(list) });

  it('lists what it found with one-click Add that runs the add for that id', async () => {
    const api = withDetect(async () => FOUND);
    const start = vi.spyOn(api, 'start');
    await act(async () => root.render(<AddAgent api={api} projectDir="C:/work/demo" />));
    await settle();
    expect(host.textContent).toContain('Found on this computer');
    expect(api.detectInstalled).toHaveBeenCalledWith('C:/work/demo');
    await click(host.querySelector('[data-found="fakenat"] button') as HTMLButtonElement);
    expect(start).toHaveBeenCalledWith('fakenat', undefined);
  });

  it('Add all adds each one after the other', async () => {
    vi.useFakeTimers();
    try {
      const api = mockAddAgentApi('native_ok');
      const both: AddAgentApi = { ...api, detectInstalled: async () => FOUND };
      await act(async () => root.render(<AddAgent api={both} />));
      await settle();
      await click(buttonByText(host, 'Add all'));
      for (let i = 0; i < 12; i++) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000);
        });
      }
      expect(api.starts.map((s) => s.input)).toEqual(['fakenat', 'faketerm']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is hidden when the call fails or finds nothing', async () => {
    const failing = async (): Promise<FoundAgent[]> => Promise.reject(new Error('no such command'));
    const none = async (): Promise<FoundAgent[]> => [];
    for (const list of [failing, none]) {
      await act(async () => root.render(<AddAgent api={withDetect(list)} />));
      await settle();
      expect(host.textContent).not.toContain('on this computer');
      expect(host.querySelector('.aa-found')).toBeNull();
      await act(async () => root.unmount());
      root = createRoot(host);
    }
  });

  it('the Settings row calls agents_detect_installed with the project folder', async () => {
    fakeBackend('native_ok', async () => FOUND);
    const m = await mountRows([agentsRows[0]]);
    try {
      await settle();
      expect(m.host.textContent).toContain('Found on this computer');
      expect(vi.mocked(invoke).mock.calls.some(([cmd]) => cmd === 'agents_detect_installed')).toBe(true);
    } finally {
      await m.unmount();
    }
  });
});
