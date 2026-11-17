// @vitest-environment jsdom
// A workflow started from the New agent page (the Workflow menu) marks its chat as the workflow's front, the same mark "Start crew"
// leaves, so the live view shows in that chat. A plain start leaves no mark.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { crewOf } from '../../../lib/crew-members';
import { runStart, type StartDeps } from './start';

const deps = (): StartDeps => ({
  newAgent: vi.fn(async () => 'term-1'),
  startChat: vi.fn(async () => 'chat-1'),
  select: vi.fn(),
  send: vi.fn(async () => undefined),
  notify: vi.fn(),
});
const base = { agentId: 'claude', folder: 'C:/work', isolated: false, runAs: 'chat' as const, prompt: 'go' };

beforeEach(() => localStorage.clear());

describe('starting a workflow from the New agent page', () => {
  it('marks the new chat as the front, with the workflow name', async () => {
    await runStart({ ...base, workflow: { slug: 'wf', name: 'Research + Write', front: 'Front', brief: 'BRIEF' } }, deps());
    expect(crewOf('chat-1')).toEqual({ slug: 'wf', role: 'Front', front: true, name: 'Research + Write' });
    // The card's record is written too, with the same name.
    expect(localStorage.getItem('pm.workflowStarts')).toContain('Research + Write');
  });

  it('writes the marks before the chat is selected', async () => {
    const d = deps();
    const seen: Array<unknown> = [];
    d.select = vi.fn(() => seen.push(crewOf('chat-1')));
    await runStart({ ...base, workflow: { slug: 'wf', name: 'W', front: 'Front', brief: 'B' } }, d);
    expect(seen[0]).toMatchObject({ front: true });
  });

  it('a plain start leaves no mark', async () => {
    await runStart(base, deps());
    expect(crewOf('chat-1')).toBeNull();
  });
});
