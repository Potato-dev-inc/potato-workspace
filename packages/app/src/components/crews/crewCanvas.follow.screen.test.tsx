// @vitest-environment jsdom
// 1.1.8 "Follow a task", through the real Settings screen and the crew canvas: the Follow tab lists the tasks the lead was given,
// picking one lights its path on the boxes with the exact words of each hand-over, "Replay" walks it box by box, a step can be
// tapped, long words are cut with "Show all", and nothing is started or sent. Only the desktop commands are faked.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPanel, type SettingsApi } from '../SettingsPanel';
import { BASE_SETTINGS, click, settle } from '../settings/test-utils';

const crew = {
  name: 'How we work',
  roles: [
    { id: 'lead', name: 'Lead', agent_type: 'claude', task: 'Lead the work.', hands_to: ['scout', 'checker'] },
    { id: 'scout', name: 'Scout', agent_type: 'claude', task: 'Look around.', parent: 'lead' },
    { id: 'worker', name: 'Worker', agent_type: 'claude', task: 'Do it.', parent: 'lead' },
    { id: 'checker', name: 'Checker', agent_type: 'claude', task: 'Check it.', parent: 'lead', check: true, hands_to: ['lead'] },
  ],
};
const LONG = 'Please look at the empty inbox copy and then '.repeat(8);
const tasks = [
  {
    id: 'p1:2',
    words: 'Fix the empty inbox copy',
    at_ms: 2_000,
    status: 'done',
    steps: [
      { role: 'Lead', from: null, words: 'Fix the empty inbox copy', at_ms: 2_000, status: 'completed', came_back: 'Handed it on.' },
      { role: 'Scout', from: 'Lead', words: LONG, at_ms: 2_100, status: 'completed', came_back: 'It is in Inbox.tsx' },
      { role: 'Checker', from: 'Lead', words: 'Check the branch', at_ms: 2_300, status: 'completed', came_back: null },
    ],
  },
  { id: 'p1:1', words: 'Older task', at_ms: 1_000, status: 'failed', steps: [{ role: 'Lead', from: null, words: 'Older task', at_ms: 1_000, status: 'failed', came_back: null }] },
];

let calls: Array<{ command: string; args: Record<string, unknown> | undefined }> = [];
let followAnswer: unknown = tasks;
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    switch (command) {
      case 'crews_list':
        return [];
      case 'crews_templates':
        return [{ slug: 'template:how-we-work', name: 'How we work', roles: 4, agents: ['claude'], problem: null }];
      case 'crews_agents':
        return { agents: [{ id: 'claude', label: 'Claude' }], default: 'claude' };
      case 'crews_open':
        return { slug: String(args?.slug), kind: 'template', crew, routing_text: '', problems: [] };
      case 'crews_follow':
        if (followAnswer instanceof Error) throw followAnswer;
        return followAnswer;
      default:
        throw new Error(`not answered in this test: ${command}`);
    }
  }),
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

let host: HTMLDivElement;
let root: Root;
const api: SettingsApi = {
  load: async () => ({ ...BASE_SETTINGS, crews_enabled: true }),
  patch: async () => ({ ...BASE_SETTINGS, crews_enabled: true }),
  findBridgeUrl: async () => null,
  subscribe: () => () => {},
};

beforeEach(async () => {
  calls = [];
  followAnswer = tasks;
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(<SettingsPanel open api={api} initialTab="helpers" initialRow="crews-page" />));
  for (let i = 0; i < 100 && !host.querySelector('.crews-page'); i++) await act(async () => new Promise((r) => setTimeout(r, 50)));
  await settle(10);
});
afterEach(async () => {
  vi.useRealTimers();
  await act(async () => root.unmount());
  host.remove();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

const text = () => document.body.textContent ?? '';
const button = (label: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
const boxes = () => [...document.querySelectorAll<HTMLElement>('[data-testid="crew-box"]')];
const lit = () => [...document.querySelectorAll<HTMLElement>('[data-testid="follow-steps"] > li')].filter((li) => li.dataset.lit === 'true');
const onPath = () => boxes().filter((b) => b.classList.contains('is-on-path')).map((b) => b.dataset.role);
const openFollow = async () => {
  await click(button('Look at it'));
  await settle(10);
  await click(button('Follow a task'));
  await settle(10);
};

describe('Follow a task, through the Settings screen and the crew canvas', () => {
  it('lists the tasks, lights the path of the one picked and shows the exact hand-overs', async () => {
    await openFollow();
    expect(calls.find((c) => c.command === 'crews_follow')!.args).toMatchObject({ crew: { name: 'How we work' } });
    const list = [...document.querySelectorAll('.crewc-follow-task')];
    expect(list.map((b) => b.querySelector('.crewc-follow-brief')!.textContent)).toEqual(['Fix the empty inbox copy', 'Older task']);
    expect(onPath()).toEqual([]);

    await click(list[0]);
    expect(list[0].getAttribute('aria-pressed')).toBe('true');
    expect(list[0].textContent).toContain('✓');
    expect(onPath()).toEqual(['lead', 'scout', 'checker']);
    expect(boxes().find((b) => b.dataset.role === 'worker')!.classList.contains('is-on-path')).toBe(false);
    expect(lit()).toHaveLength(3);
    expect(document.querySelectorAll('.crewc-line.is-lit').length).toBeGreaterThanOrEqual(2);
    expect(text()).toContain('Lead handed to Scout');
    expect(text()).toContain('Lead got the task');
    expect(text()).toContain('Came back: It is in Inbox.tsx');
    expect(text()).toContain('Check the branch');
  });

  it('cuts long words and shows all of them on request', async () => {
    await openFollow();
    await click(document.querySelector('.crewc-follow-task'));
    expect(text()).not.toContain(LONG);
    await click(button('Show all'));
    expect(text()).toContain(LONG);
    await click(button('Show less'));
    expect(text()).not.toContain(LONG);
  });

  it('replays the path box by box, and a step can be tapped', async () => {
    await openFollow();
    await click(document.querySelector('.crewc-follow-task'));
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    await click(button('Replay'));
    expect(lit()).toHaveLength(0);
    expect(onPath()).toEqual([]);
    expect(button('Playing…')!.disabled).toBe(true);
    await act(async () => vi.advanceTimersByTime(900));
    expect(lit()).toHaveLength(1);
    expect(onPath()).toEqual(['lead']);
    expect(boxes().filter((b) => b.classList.contains('is-now')).map((b) => b.dataset.role)).toEqual(['lead']);
    await act(async () => vi.advanceTimersByTime(900));
    expect(onPath()).toEqual(['lead', 'scout']);
    expect(boxes().filter((b) => b.classList.contains('is-now')).map((b) => b.dataset.role)).toEqual(['scout']);
    await act(async () => vi.advanceTimersByTime(900));
    expect(lit()).toHaveLength(3);
    expect(button('Replay')!.disabled).toBe(false);
    vi.useRealTimers();

    await click(document.querySelectorAll('.crewc-follow-step')[1]);
    expect(lit()).toHaveLength(2);
    expect(onPath()).toEqual(['lead', 'scout']);
  });

  it('only reads: nothing is started, saved or sent while following', async () => {
    await openFollow();
    await click(document.querySelector('.crewc-follow-task'));
    const writes = calls.map((c) => c.command).filter((c) => c.startsWith('crews_')).filter((c) => !['crews_list', 'crews_templates', 'crews_agents', 'crews_open', 'crews_follow', 'crews_starters'].includes(c));
    expect(writes).toEqual([]);
  });

  it('says so when there are no tasks yet, and when they cannot be read', async () => {
    followAnswer = [];
    await openFollow();
    expect(text()).toContain('No tasks to follow yet.');
    followAnswer = new Error('INTERNAL: no');
    await click(button('Look again'));
    await settle(5);
    expect(document.querySelector('.crewc-follow [role="alert"]')).not.toBeNull();
  });
});
