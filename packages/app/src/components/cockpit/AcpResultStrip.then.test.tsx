// @vitest-environment jsdom
// "Then…" on a chat's result: add one chain step that runs when the chat finishes.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcpResult } from './acp-pane';
import { AcpResultStrip } from './AcpResultStrip';
import { thenWorkflow } from './routines/ThenSheet';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const result: AcpResult = { files: '3 files +14 −3', paths: [], summary: 'Fixed the total.', checks: [], questions: [] };

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  invoke.mockImplementation(async (name: string) => (name === 'routines_agents' ? [{ id: 'codex', label: 'Codex' }] : 'rt-00000001'));
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  invoke.mockReset();
});

const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label);
const setText = (el: Element, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

describe('Then… on the result card', () => {
  it('has no Then button without a chat to attach to (the old strip is unchanged)', () => {
    act(() => root.render(<AcpResultStrip result={result} />));
    expect(button('Then…')).toBeUndefined();
    expect(host.textContent).toContain('Fixed the total.');
  });

  it('adds a "send a message" chain on this chat, only if it went well, and says so', async () => {
    const notify = vi.fn();
    act(() => root.render(<AcpResultStrip result={result} paneId="p1" cwd="C:/work/shop" onNotify={notify} />));
    act(() => button('Then…')!.click());
    expect(host.querySelector('[aria-label="After this chat finishes"]')).toBeTruthy();
    await act(async () => setText(host.querySelector('textarea')!, 'now run the tests'));
    await act(async () => {
      host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(invoke).toHaveBeenCalledWith('routines_create', {
      workflow: {
        name: 'Then: send a message',
        trigger: { kind: 'chat_finished', pane_id: 'p1', only_if_ok: true },
        steps: [{ kind: 'follow_up', text: 'now run the tests' }],
      },
    });
    expect(notify).toHaveBeenCalledWith('Added. It runs when this chat finishes. See Routines.');
    expect(host.querySelector('form')).toBeNull();
  });

  it('Add stays off until there is a message', () => {
    act(() => root.render(<AcpResultStrip result={result} paneId="p1" cwd="C:/w" />));
    act(() => button('Then…')!.click());
    expect(button('Add')!.disabled).toBe(true);
  });

  it('can start another agent in the same folder and wait for it', async () => {
    act(() => root.render(<AcpResultStrip result={result} paneId="p1" cwd="C:/work/shop" />));
    act(() => button('Then…')!.click());
    await act(async () => {});
    act(() => button('Start another agent here')!.click());
    await act(async () => setText(host.querySelector('textarea')!, 'review the change'));
    await act(async () => {
      host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    const sent = invoke.mock.calls.find((c) => c[0] === 'routines_create')![1].workflow;
    expect(sent.steps).toEqual([{ kind: 'start_agent', agent: 'codex', project: 'C:/work/shop', task: 'review the change', separate_copy: false }, { kind: 'wait' }]);
  });

  it('Cancel closes the sheet without adding anything', () => {
    act(() => root.render(<AcpResultStrip result={result} paneId="p1" cwd="C:/w" />));
    act(() => button('Then…')!.click());
    act(() => button('Cancel')!.click());
    expect(host.querySelector('form')).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith('routines_create', expect.anything());
  });
});

describe('thenWorkflow', () => {
  it('builds the JSON the engine stores', () => {
    const w = thenWorkflow({ paneId: 'p9', onlyIfOk: false, mode: 'tell', text: 'done', agent: '', project: '', name: 'n' });
    expect(w).toEqual({ name: 'n', trigger: { kind: 'chat_finished', pane_id: 'p9', only_if_ok: false }, steps: [{ kind: 'notify', text: 'done' }] });
  });
});
