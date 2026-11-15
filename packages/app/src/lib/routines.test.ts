// @vitest-environment jsdom
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { routineSteps, routinesApi, routinesError } from './routines';

const RUST = fs.readFileSync(path.resolve(__dirname, '../../src-tauri/src/commands/routines.rs'), 'utf8');
const LIB = fs.readFileSync(path.resolve(__dirname, '../../src-tauri/src/lib.rs'), 'utf8');

beforeEach(() => invoke.mockResolvedValue(undefined));
afterEach(() => invoke.mockReset());

describe('routinesApi', () => {
  it('calls the commands the Rust file declares, by name and argument key', async () => {
    await routinesApi.view();
    await routinesApi.agents();
    await routinesApi.create({ name: 'n', trigger: { kind: 'manual' }, steps: [{ kind: 'wait' }] });
    await routinesApi.setEnabled('rt-1', true);
    await routinesApi.remove('rt-1');
    await routinesApi.runNow('rt-1');
    await routinesApi.stopRun('rr-1');
    await routinesApi.setLimit(3);
    const calls = invoke.mock.calls.map((c) => c[0] as string);
    expect(calls).toEqual(['routines_view', 'routines_agents', 'routines_create', 'routines_set_enabled', 'routines_delete', 'routines_run_now', 'routines_stop_run', 'routines_set_limit']);
    for (const name of new Set(calls)) {
      expect(RUST, `${name} in commands/routines.rs`).toContain(`pub async fn ${name}(`);
      expect(LIB, `${name} registered in lib.rs`).toContain(`commands::${name},`);
    }
    // camelCase keys on the wire (Tauri turns them into the Rust snake_case arguments).
    expect(invoke).toHaveBeenCalledWith('routines_stop_run', { runId: 'rr-1' });
    expect(RUST).toContain('run_id: String');
    expect(invoke).toHaveBeenCalledWith('routines_set_limit', { limit: 3 });
  });

  it('sends a workflow in the same JSON the engine saves', async () => {
    const steps = routineSteps({ agent: 'claude', project: 'C:/p', task: ' do it ', separateCopy: true, notify: true, notifyText: 'done' });
    expect(steps).toEqual([
      { kind: 'start_agent', agent: 'claude', project: 'C:/p', task: 'do it', separate_copy: true },
      { kind: 'wait' },
      { kind: 'notify', text: 'done' },
    ]);
    expect(routineSteps({ agent: 'a', project: 'p', task: 't', separateCopy: false, notify: false, notifyText: '' })).toHaveLength(2);
  });

  it('turns any failure into one sentence', () => {
    expect(routinesError('Give it a name.')).toBe('Give it a name.');
    expect(routinesError(new Error('boom'))).toBe('boom');
    expect(routinesError({ message: 'x' })).toBe('x');
  });
});
