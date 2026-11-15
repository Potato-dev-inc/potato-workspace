// @vitest-environment jsdom
// The hand-off of a failed Worker update: the chat starts with the task in its message box (a draft), never sent.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestAddAgentAction } from '../../lib/addAgentActions';
import { readDraft } from '../../lib/composerDraft';
import { AddAgentActionHost } from './AddAgentActionHost';

vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn(async () => undefined), listen: vi.fn(async () => () => undefined) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('AddAgentActionHost: chat with a task', () => {
  it('starts the chat, puts the task in its message box and opens it, without sending', async () => {
    const select = vi.fn();
    const startChat = vi.fn(async () => 'pane-77');
    const c = { newAgent: vi.fn(), select, notify: vi.fn() };
    await act(async () => root.render(<AddAgentActionHost c={c as never} folder="/work/demo" startChat={startChat} />));
    await act(async () => requestAddAgentAction('chat', 'helper', 'Please finish the Worker update.'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(startChat).toHaveBeenCalledWith('helper', '/work/demo');
    expect(readDraft('pane-77')).toBe('Please finish the Worker update.');
    expect(select).toHaveBeenCalledWith('pane-77');
  });

  it('a chat without a task leaves the message box empty', async () => {
    const select = vi.fn();
    const c = { newAgent: vi.fn(), select, notify: vi.fn() };
    await act(async () => root.render(<AddAgentActionHost c={c as never} folder="/work/demo" startChat={async () => 'pane-78'} />));
    await act(async () => requestAddAgentAction('chat', 'helper'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(readDraft('pane-78')).toBe('');
    expect(select).toHaveBeenCalledWith('pane-78');
  });
});
