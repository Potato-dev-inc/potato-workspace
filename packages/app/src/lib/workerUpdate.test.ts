import { describe, expect, it, vi } from 'vitest';
import type { AcpLaneView } from './acpChat';
import { freshSteps, handoffTask, isUpToDate, MAX_TRIES, pickHandoffAgent, runWorkerUpdate, type StepAnswer, type UpdateApi, type UpdateStepId } from './workerUpdate';

const LABELS: Record<UpdateStepId, string> = { prepare: 'Getting the Worker files ready', install: 'Installing the tool it needs', login: 'Signing in to Cloudflare', deploy: 'Putting the Worker online', check: 'Checking that it works' };
const GOOD = { reachable: true, features: ['team', 'rooms', 'stable-link', 'invites'], legacyLink: false };

function api(answer: (id: string, call: number) => StepAnswer | Error, health = GOOD): UpdateApi & { calls: string[] } {
  const calls: string[] = [];
  const count: Record<string, number> = {};
  return {
    calls,
    step: vi.fn(async (id) => {
      calls.push(id);
      count[id] = (count[id] ?? 0) + 1;
      const a = answer(id, count[id]);
      if (a instanceof Error) throw a;
      return a;
    }),
    check: vi.fn(async () => health),
  };
}

describe('the Worker update step runner', () => {
  it('runs the steps in order and finishes with a check of the Worker', async () => {
    const a = api(() => ({ ok: true, output: '' }));
    const seen: string[] = [];
    const run = await runWorkerUpdate({ address: 'https://pm-relay.me.workers.dev', api: a, pauseMs: 0, onChange: (s) => seen.push(s.map((x) => x.status[0]).join('')) });
    expect(a.calls).toEqual(['prepare', 'install', 'login', 'deploy']);
    expect(run.ok).toBe(true);
    expect(run.steps.map((s) => s.status)).toEqual(['done', 'done', 'done', 'done', 'done']);
    expect(seen[0]).toBe('wwwww');
    expect(a.check).toHaveBeenCalledWith('https://pm-relay.me.workers.dev');
  });

  it('tries a failed step again, and a step that works on the third try is fine', async () => {
    const a = api((id, n) => (id === 'install' && n < 3 ? { ok: false, output: 'network down' } : { ok: true, output: '' }));
    const statuses: string[] = [];
    const run = await runWorkerUpdate({ address: null, api: a, pauseMs: 0, onChange: (s) => statuses.push(s[1].status) });
    expect(a.calls.filter((c) => c === 'install')).toHaveLength(3);
    expect(statuses).toContain('retrying');
    expect(run.steps[1]).toMatchObject({ status: 'done', tries: 3 });
  });

  it('after 3 failed tries it stops at that step and the later steps never run', async () => {
    const a = api((id) => (id === 'login' ? { ok: false, output: 'denied by the person' } : { ok: true, output: '' }));
    const run = await runWorkerUpdate({ address: 'https://w.me.workers.dev', api: a, pauseMs: 0 });
    expect(MAX_TRIES).toBe(3);
    expect(a.calls.filter((c) => c === 'login')).toHaveLength(3);
    expect(a.calls).not.toContain('deploy');
    expect(run).toMatchObject({ ok: false, failed: 'login' });
    expect(run.steps.map((s) => s.status)).toEqual(['done', 'done', 'failed', 'waiting', 'waiting']);
  });

  it('a step that throws counts as a failed try, with a plain sentence', async () => {
    const a = api((id) => (id === 'prepare' ? new Error('boom') : { ok: true, output: '' }));
    const run = await runWorkerUpdate({ address: null, api: a, pauseMs: 0 });
    expect(run.failed).toBe('prepare');
    expect(run.steps[0].output).not.toBe('');
  });

  it('a Worker that still lacks the features fails the last step; a new Worker takes the address the deploy printed', async () => {
    const old = api(() => ({ ok: true, output: '' }), { reachable: true, features: ['team'], legacyLink: true });
    expect((await runWorkerUpdate({ address: 'https://w.me.workers.dev', api: old, pauseMs: 0 })).failed).toBe('check');
    const fresh = api((id) => ({ ok: true, output: '', url: id === 'deploy' ? 'https://pm-relay.me.workers.dev' : undefined }));
    const run = await runWorkerUpdate({ address: null, api: fresh, pauseMs: 0 });
    expect(run).toMatchObject({ ok: true, address: 'https://pm-relay.me.workers.dev' });
    expect(fresh.check).toHaveBeenCalledWith('https://pm-relay.me.workers.dev');
  });

  it('isUpToDate wants an answer with features and not the old link-only Worker', () => {
    expect(isUpToDate(GOOD)).toBe(true);
    expect(isUpToDate(null)).toBe(false);
    expect(isUpToDate({ ...GOOD, legacyLink: true })).toBe(false);
    expect(isUpToDate({ reachable: false, features: [], legacyLink: false })).toBe(false);
  });
});

describe('the hand-off note', () => {
  it('names the goal, the failing step and what it printed, and contains no command to run', async () => {
    const a = api((id) => (id === 'deploy' ? { ok: false, output: 'Authentication error [code: 10000]' } : { ok: true, output: '' }));
    const run = await runWorkerUpdate({ address: 'https://pm-relay.me.workers.dev', api: a, pauseMs: 0 });
    const task = handoffTask(run, LABELS);
    expect(task).toContain('https://pm-relay.me.workers.dev');
    expect(task).toContain(`The step that failed ${MAX_TRIES} times: Putting the Worker online`);
    expect(task).toContain('Authentication error [code: 10000]');
    expect(task).toContain('Steps that worked: Getting the Worker files ready, Installing the tool it needs, Signing in to Cloudflare.');
    expect(task).not.toMatch(/npx wrangler|npm run deploy|cd relay/);
  });

  it('cuts very long output to its last part', () => {
    const run = { ok: false, failed: 'install' as const, address: null, steps: freshSteps().map((s) => (s.id === 'install' ? { ...s, status: 'failed' as const, output: `${'a'.repeat(9000)}END` } : s)) };
    const task = handoffTask(run, LABELS);
    expect(task.length).toBeLessThan(4500);
    expect(task).toContain('END');
  });

  it('picks the first chat agent that is ready, none when nothing can chat', () => {
    const agent = (id: string, over: object = {}) => ({ id, label: id.toUpperCase(), lane: 'acp', effective_lane: 'acp', ...over });
    const view = { labs_enabled: true, agents: [agent('a', { effective_lane: 'terminal' }), agent('b', { addon_installed: false }), agent('c'), agent('d')] } as unknown as AcpLaneView;
    expect(pickHandoffAgent(view)).toEqual({ id: 'c', label: 'C' });
    expect(pickHandoffAgent({ ...view, labs_enabled: false })).toBeNull();
    expect(pickHandoffAgent(null)).toBeNull();
  });
  it('also picks agents saved to run in the terminal (the New agent page offers Chat for them), the last used one first', () => {
    const agent = (id: string, over: object = {}) => ({ id, label: id.toUpperCase(), lane: 'terminal', effective_lane: 'terminal', disabled: false, ...over });
    const view = { labs_enabled: true, agents: [agent('claude'), agent('codex'), agent('opencode', { disabled: true })] } as unknown as AcpLaneView;
    expect(pickHandoffAgent(view, null)).toEqual({ id: 'claude', label: 'CLAUDE' });
    expect(pickHandoffAgent(view, 'codex')).toEqual({ id: 'codex', label: 'CODEX' });
    expect(pickHandoffAgent(view, 'opencode')).toEqual({ id: 'claude', label: 'CLAUDE' });
    expect(pickHandoffAgent({ ...view, agents: [] }, 'codex')).toBeNull();
  });
});
