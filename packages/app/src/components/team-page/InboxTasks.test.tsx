// @vitest-environment jsdom
// Inbox > Team shows tasks passed to me that wait for an answer, with the same card as the Tasks tab.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { teamState } from '../../dev/team-fixtures';
import type { LendApi } from '../../lib/lend';
import type { TeamApi } from '../../lib/team';
import { EMPTY_TASKS, type RecvTask, type TasksView, type TeamTasksApi } from '../../lib/team-tasks';
import { TeamSection } from '../cockpit/team/TeamSection';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const NOW = Date.now();
const task = (over: Partial<RecvTask> = {}): RecvTask => ({
  id: 'r1', fromMember: 'm-maya', fromName: 'Maya', fromDevice: 'd', title: 'Fix the sheet', text: '<b>cut</b> at 320 px', summary: '', repo: null, lend: null, state: 'new', atMs: NOW, updatedMs: NOW,
  risk: null, usage: 'theirs', lendError: null, repoState: 'none', repoGot: 0, repoError: null, unpacked: null, ...over,
});
const team = { state: async () => teamState({ cards: [] }), onChanged: async () => () => {}, onDraft: async () => () => {} } as unknown as TeamApi;
const lend = { state: async () => ({ enabled: false, profiles: [], grants: [], requests_in: [], requests_out: [], drivers: [] }), offers: async () => ({ answered: false, offers: [] }), onChanged: async () => () => {} } as unknown as LendApi;
const tasksApi = (view: Partial<TasksView>) => {
  const calls: string[] = [];
  const api = { calls, state: async () => ({ ...EMPTY_TASKS, ...view }), seen: async (id: string) => void calls.push(`seen(${id})`), decline: async (id: string) => void calls.push(`decline(${id})`), onChanged: async () => () => {} } as unknown as TeamTasksApi & { calls: string[] };
  return api;
};
const show = async (api: TeamTasksApi) => {
  await act(async () => root.render(<TeamSection api={team} lend={lend} tasksApi={api} now={NOW} />));
  await act(async () => {});
  await act(async () => {});
};

describe('Inbox > Team: tasks passed to me', () => {
  it('lists a waiting task as plain quoted text with Accept… and Decline', async () => {
    const api = tasksApi({ received: [task(), task({ id: 'r2', state: 'accepted', title: 'Not waiting' })] });
    await show(api);
    const box = host.querySelector('[data-testid="inbox-tasks"]')!;
    expect(box.textContent).toContain('Maya passed you a task');
    expect(box.textContent).not.toContain('Not waiting');
    expect(box.querySelector('[data-testid="task-text"]')!.textContent).toBe('<b>cut</b> at 320 px');
    expect(box.querySelector('b')).toBeNull();
    const buttons = [...box.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons).toEqual(expect.arrayContaining(['Accept…', 'Decline']));
    await act(async () => [...box.querySelectorAll('button')].find((b) => b.textContent === 'Decline')!.click());
    expect(api.calls).toContain('decline(r1)');
  });

  it('shows nothing when no task waits', async () => {
    await show(tasksApi({ received: [task({ state: 'done' })] }));
    expect(host.querySelector('[data-testid="inbox-tasks"]')).toBeNull();
  });
});
