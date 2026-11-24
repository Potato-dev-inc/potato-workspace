import { describe, expect, it } from 'vitest';
import type { AgentInstallApi, InstallPlan, InstallStep } from '../agent-install';
import { FAR_INSTALL_TRIES, runFarInstall, type StepProgress } from './farInstall';

const step = (index: number, high_risk = false): InstallStep => ({ index, label: `S${index}`, tool: null, method: 'npm', command: `c${index}`, source: 'https://x.example/', source_host: 'x.example', high_risk, note: '' });
const plan = (steps: InstallStep[]): InstallPlan => ({ agent_id: 'a', label: 'A', available: true, reason: null, hint: null, steps });

/** A far PC whose runs end with the given exit codes, in order (the last one repeats); `throws` makes the first runs refuse. */
function fakeApi(exits: number[], throws = 0) {
  const runs: Array<[number, string, boolean]> = [];
  const api: AgentInstallApi = {
    plan: async () => plan([]),
    run: async (_a, i, shown, risk) => {
      runs.push([i, shown, risk]);
      if (runs.length <= throws) throw new Error('INSTALL_COMMAND_CHANGED: not the one shown');
      return { pane_id: `p${runs.length}`, command: shown, label: 'x' };
    },
    status: async (pane) => ({ known: true, done: true, exit_code: exits[Math.min(Number(pane.slice(1)), exits.length) - 1], message: 'did not finish' }),
    finish: async () => ({ path_added: [], health: { installed: true } as never, needs_restart: false }),
  };
  return { api, runs };
}
const deps = (api: AgentInstallApi, seen: StepProgress[] = [], cancelled = () => false) => ({ api, sleep: async () => undefined, cancelled, report: (p: StepProgress) => seen.push(p) });

describe('runFarInstall', () => {
  it('runs the steps in order and sends back the command it was shown', async () => {
    const { api, runs } = fakeApi([0]);
    const seen: StepProgress[] = [];
    expect(await runFarInstall('a', plan([step(0), step(1)]), false, deps(api, seen))).toEqual({ ok: true });
    expect(runs).toEqual([[0, 'c0', false], [1, 'c1', false]]);
    expect(seen.filter((p) => p.kind === 'done').length).toBe(2);
  });

  it('tries a failing step three times and then names that step with the last reason', async () => {
    const { api, runs } = fakeApi([1]);
    const out = await runFarInstall('a', plan([step(0), step(1)]), false, deps(api));
    expect(runs.length).toBe(FAR_INSTALL_TRIES);
    expect(out).toMatchObject({ ok: false, message: 'did not finish', step: { index: 0 } });
  });

  it('a second try that works passes the step', async () => {
    const { api, runs } = fakeApi([1, 0]);
    expect(await runFarInstall('a', plan([step(0)]), false, deps(api))).toEqual({ ok: true });
    expect(runs.length).toBe(2);
  });

  it('a refusal from the far PC counts as a failed try with its sentence', async () => {
    const { api, runs } = fakeApi([0], 3);
    const out = await runFarInstall('a', plan([step(0)]), false, deps(api));
    expect(runs.length).toBe(3);
    expect(out).toMatchObject({ ok: false, message: 'not the one shown' });
  });

  it('a script step carries the second yes only when it was given', async () => {
    const a = fakeApi([0]);
    await runFarInstall('a', plan([step(0, true)]), false, deps(a.api));
    const b = fakeApi([0]);
    await runFarInstall('a', plan([step(0, true)]), true, deps(b.api));
    expect([a.runs[0][2], b.runs[0][2]]).toEqual([false, true]);
  });

  it('stops without another try when the person stopped it', async () => {
    const { api, runs } = fakeApi([1]);
    expect(await runFarInstall('a', plan([step(0)]), false, deps(api, [], () => runs.length >= 1))).toBe('stopped');
    expect(runs.length).toBe(1);
  });
});
