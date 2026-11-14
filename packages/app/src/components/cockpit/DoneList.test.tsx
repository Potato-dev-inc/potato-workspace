// @vitest-environment jsdom
// Screen-level: the Done list on a chat's result card: tick, cross with "Fix it", "not checked", and the editor.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetComposerInserts, takeComposerInserts } from '../../lib/composer-insert';
import type { ChatTurn, ToolStep } from '../../lib/sessionChatModel';
import { DoneListFor, worthChecking } from './DoneList';

vi.mock('../../hooks/useSessionChat', () => ({ useSessionChat: () => ({ turns: [] }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const step = (id: string, command: string, status: 'ok' | 'error', output = ''): ToolStep => ({
  kind: 'tool',
  id,
  call: { kind: 'toolCall', id, at: null, callId: id, name: 'Bash', summary: command, input: { command } },
  result: { kind: 'toolResult', id: `${id}r`, at: null, callId: id, ok: status === 'ok', output },
  status,
});
const turn = (...steps: ToolStep[]): ChatTurn => ({
  id: 't',
  user: null,
  steps,
  end: { kind: 'turnEnd', id: 'e', at: null, outcome: 'completed', durationMs: 1 },
  outcome: 'completed',
  durationMs: 1,
  ending: null,
  plan: null,
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  resetComposerInserts();
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const show = (t: ChatTurn | undefined) => act(async () => root.render(<DoneListFor paneId="p1" cwd="C:/work/shop" turn={t} />));
const rows = () => [...host.querySelectorAll<HTMLElement>('.ck-done-row')];
const btn = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement;

describe('Done list', () => {
  it('shows a tick, a cross with "Fix it", and "not checked" per line', async () => {
    await show(turn(step('1', 'npm run build', 'ok'), step('2', 'npm test', 'error', '2 failed')));
    expect(rows().map((r) => r.dataset.state)).toEqual(['pass', 'fail']);
    expect(rows()[0].querySelector('[role="img"]')!.getAttribute('aria-label')).toBe('Passed');
    expect(rows()[1].querySelector('[role="img"]')!.getAttribute('aria-label')).toBe('Did not pass');
    expect(rows()[1].textContent).toContain('2 failed');
    expect(rows()[0].querySelector('button')).toBeNull();
  });

  it('"Fix it" writes the problem in the message box and sends nothing', async () => {
    await show(turn(step('2', 'npm test', 'error', '2 failed')));
    await act(async () => btn('Fix it').click());
    expect(takeComposerInserts('p1')).toBe('The check "Tests pass" did not pass (2 failed). Please fix it and run it again.');
  });

  it('a line nothing checked says "Not checked"', async () => {
    await show(turn(step('1', 'echo hi', 'ok'), step('2', 'git status', 'ok')));
    expect(rows().map((r) => r.dataset.state)).toEqual(['unchecked', 'unchecked']);
    expect(rows()[0].textContent).toContain('Not checked');
  });

  it('shows nothing for a turn that only talked, and nothing before there is a turn', async () => {
    const talk = { ...turn(), steps: [] } as ChatTurn;
    expect(worthChecking(talk)).toBe(false);
    await show(talk);
    expect(host.querySelector('[data-testid="done-list"]')).toBeNull();
    await show(undefined);
    expect(host.querySelector('[data-testid="done-list"]')).toBeNull();
  });

  it('the project lines replace the usual two and are kept for the project', async () => {
    await show(turn(step('1', 'npm test', 'ok')));
    await act(async () => btn('Edit').click());
    const box = host.querySelector<HTMLTextAreaElement>('textarea')!;
    expect(box.value).toBe('Build passes\nTests pass');
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      set.call(box, 'All tests are green\nThe page looks right');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => btn('Save').click());
    expect(rows().map((r) => [r.querySelector('.ck-done-line')!.textContent, r.dataset.state])).toEqual([
      ['All tests are green', 'pass'],
      ['The page looks right', 'unchecked'],
    ]);
    // A new window for the same project reads the same lines.
    act(() => root.unmount());
    root = createRoot(host);
    await show(turn(step('1', 'npm test', 'ok')));
    expect(rows()[0].querySelector('.ck-done-line')!.textContent).toBe('All tests are green');
  });
});
