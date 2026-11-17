// @vitest-environment jsdom
// The Live tab opened from a workflow's own chat (the chat hands over its pane id, the cockpit's pane list and its waiting
// questions): two runs of one crew never mix, the counts match the crew chip, helpers that fit no box are listed, and the
// separate Settings window has no Live tab at all.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { crewChipView, crewCounts, crewMembers } from '../../lib/crew-chip';
import type { CrewsApi } from '../../lib/crews-api';
import { CrewCanvas } from './CrewCanvas';

const crew = {
  name: 'Router',
  roles: [
    { name: 'Front', agent_type: 'claude', model: 'haiku', task: 'Route.', front: true },
    { name: 'Test', agent_type: 'claude', model: 'sonnet', task: 'Tests.', parent: 'Front' },
    { name: 'Tester', agent_type: 'claude', model: 'sonnet', task: 'More tests.', parent: 'Front' },
  ],
};
const api = {
  open: async () => ({ slug: 'wf', kind: 'saved', crew, routing_text: '', problems: [] }),
  agents: async () => ({ agents: [{ id: 'claude', label: 'Claude' }], default: 'claude' }),
  check: async () => [],
} as unknown as CrewsApi;

const NOW = Date.now();
type P = { info: Record<string, unknown>; status: string };
const pane = (id: string, parent: string | null, status: string, task = 'do it'): P => ({
  info: { id, agent_type: 'claude', created_at: NOW - 60000, parent_pane_id: parent, started_as: parent ? 'minion' : null, origin: { task }, status },
  status,
});
const panes: P[] = [pane('front-old', null, 'idle'), pane('front-new', null, 'running'), pane('old-1', 'front-old', 'idle', 'old run: Tester job'), pane('new-1', 'front-new', 'running', 'new run: Test job'), pane('new-2', 'front-new', 'running', 'something else')];

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
  window.history.replaceState(null, '', '/');
});
const settle = async () => {
  for (let i = 0; i < 12; i++) await act(async () => new Promise((r) => setTimeout(r, 10)));
};
const show = async (frontId: string, asking: string[] = [], onOpenHelper = vi.fn()) => {
  await act(async () =>
    root.render(<CrewCanvas slug="wf" api={api} workflows startTab="live" onClose={() => {}} onOpenHelper={onOpenHelper} liveSource={{ frontId, panes: panes as never, asking: new Set(asking) }} />),
  );
  await settle();
  return onOpenHelper;
};
const box = (role: string) => document.querySelector<HTMLElement>(`[data-testid="crew-box"][data-role="${role}"]`)!;

describe('the Live tab opened from a workflow chat', () => {
  it('shows the run of the chat that opened it, not the newest run of the crew', async () => {
    const open = await show('front-old');
    expect(box('Tester').textContent).toContain('Done');
    expect(box('Test').textContent).not.toContain('Working');
    await act(async () => box('Tester').click());
    expect(open).toHaveBeenCalledWith('front-old', 'old-1');
  });

  it('matches whole words and gives a second agent a free box', async () => {
    await show('front-new');
    expect(box('Test').getAttribute('data-live-state')).toBe('working'); // "Test job" -> Test, not Tester
    expect(box('Tester').getAttribute('data-live-state')).toBe('working'); // the untitled one takes the free box
    expect(document.querySelector('[data-testid="live-other"]')).toBeNull();
  });

  it('counts exactly as the crew chip does, questions included', async () => {
    await show('front-new', ['new-1']);
    const members = crewMembers(panes as never, 'front-new', (p: P) => String(p.info.agent_type), new Set(['new-1']));
    const counts = crewCounts(members);
    expect(counts).toMatchObject({ needsYou: 1, working: 1 });
    expect(crewChipView(members)!.text).toBe('1 needs you · 1 working');
    expect(document.querySelector('[data-testid="live-summary"]')!.textContent).toBe('1 agent working, 1 needs you');
    expect(box('Test').textContent).toContain('Needs you');
  });

  it('keeps Add a role and Save off while the Live tab is open', async () => {
    await show('front-new');
    const off = ['Add a role', 'Save'].map((n) => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === n)!.disabled);
    expect(off).toEqual([true, true]);
  });
});
