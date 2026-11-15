// @vitest-environment jsdom
// An agent took the standby the person was using: the chat shows the banner, the person's last message is back in the box,
// the box is locked, and "Stop the task and take it back" calls the backend. Nothing shows for any other chat.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { SessionChatPanel } from './SessionChatPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let view: unknown;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const helper = (over: Record<string, unknown> = {}) => ({ id: 'sb-1', name: 'Reviewer', agent: 'codex', model: null, project: 'C:/p', after_task: 'wait', state: 'busy', note: null, pane_id: 'task-1', home: 'a1', used_by: 'agent', taken_over: true, open_pane: null, person_pane: 'p1', ...over });

beforeEach(() => {
  (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
  localStorage.clear();
  view = { helpers: [helper()], max: 4, idle_minutes: 30 };
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'session_chat_open') return { available: true, reason: null, items: [{ kind: 'user', id: 'u1', at: null, text: 'please review the diff' }], source: 'file' };
    if (cmd === 'pane_messages_list') return [];
    if (cmd === 'standby_helpers_get') return view;
    if (cmd === 'standby_helper_take_back') {
      view = { helpers: [helper({ state: 'ready', used_by: null, taken_over: false, person_pane: null })], max: 4, idle_minutes: 30 };
      return view;
    }
    return undefined;
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

const open = async (paneId: string) => {
  act(() => root.render(<SessionChatPanel paneId={paneId} reply={{ blockedReason: null }} />));
  await flush();
  await flush();
};

describe('a standby taken over while the person used it', () => {
  it('shows the banner, puts their message back in the box, and locks the box', async () => {
    await open('p1');
    expect(host.querySelector('[data-testid="takeover-banner"]')!.textContent).toContain('An agent took Reviewer for a task.');
    expect((host.querySelector('textarea') as HTMLTextAreaElement).value).toBe('please review the diff');
    expect(host.textContent).toContain('Busy with a task from an agent');
  });

  it('"Stop the task and take it back" calls the backend and the banner goes', async () => {
    await open('p1');
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="takeover-take-back"]')!.click());
    await flush();
    expect(invoke).toHaveBeenCalledWith('standby_helper_take_back', { id: 'sb-1' });
    expect(host.querySelector('[data-testid="takeover-banner"]')).toBeNull();
    expect(host.textContent).not.toContain('Busy with a task from an agent');
  });

  it('another chat shows nothing', async () => {
    await open('other');
    expect(host.querySelector('[data-testid="takeover-banner"]')).toBeNull();
    expect((host.querySelector('textarea') as HTMLTextAreaElement).value).toBe('');
  });
});
