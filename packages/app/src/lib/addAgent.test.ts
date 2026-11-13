// @vitest-environment jsdom
// The Add-an-agent types: the mock runs obey the capability rules, and the real api calls the reserved command names.
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addAgentApi, checkCaps, ERROR_COPY, stepLine, type AddAgentRun, type AddAgentStep } from './addAgent';
import { chatCaps, emptyCaps, SCENARIOS, terminalCaps } from './addAgent.mocks';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => undefined) }));

describe('addAgent', () => {
  it('every mock frame passes the caps invariants', () => {
    let frames = 0;
    for (const [name, scenario] of Object.entries(SCENARIOS)) {
      for (const f of scenario.frames) {
        frames++;
        const caps = f.run.result?.caps;
        if (caps) expect(checkCaps(caps), name).toEqual([]);
        // the whole plan is in every frame, in order
        expect(f.run.steps.map((s) => s.id), name).toEqual(['find', 'version', 'chat_way', 'handshake', 'models', 'save', 'install']);
        if (f.run.error) expect(Object.keys(ERROR_COPY)).toContain(f.run.error.code);
      }
    }
    expect(frames).toBeGreaterThan(40);
    expect(Object.keys(SCENARIOS).sort()).toEqual(
      ['already_added', 'cancelled', 'chat_off', 'handshake_bad', 'handshake_silent', 'install_failed', 'native_ok', 'needs_consent', 'not_installed', 'registry_addon', 'sign_in', 'slow', 'terminal_only', 'unknown_name'].sort(),
    );
  });

  it('the invariant check catches a claim without proof', () => {
    const bad = chatCaps('x', 'X');
    bad.usage = { value: 'yes', source: 'unknown', proof: '', at: null };
    expect(checkCaps(bad).length).toBeGreaterThan(0);
    const noModels = { ...chatCaps('x', 'X'), models: [] as string[] };
    expect(checkCaps(noModels)).toContain('model_pick: yes needs models');
    const chatNo = { ...terminalCaps('t', 'T'), level: 'l0' as const };
    expect(checkCaps(chatNo)).toContain('chat: no needs level l5');
    expect(checkCaps(terminalCaps('t', 'T'))).toEqual([]);
    expect(checkCaps(emptyCaps('e', 'E'))).toEqual([]);
  });

  it('the version line shows the real number or says it is not shown, never that it was read', () => {
    const step = (state: AddAgentStep['state'], detail: string | null): AddAgentStep => ({ id: 'version', state, started_ms: 1, elapsed_ms: 1, limit_ms: 5000, detail });
    expect(stepLine(step('done', '1.4.2'), 'Fakenat', null)).toBe('Version 1.4.2');
    expect(stepLine(step('done', null), 'Fakenat', chatCaps('x', 'X'))).toMatch(/^Version /);
    expect(stepLine(step('done', 'ran --version ok'), 'Fakenat', null)).toBe('Version not shown');
    expect(stepLine(step('done', null), 'Fakenat', emptyCaps('x', 'X'))).toBe('Version not shown');
    expect(stepLine(step('skipped', 'no version shown'), 'Fakenat', null)).toBe('Version not shown');
    expect(stepLine(step('running', null), 'Fakenat', null)).toBe('Reading its version');
  });

  describe('real api', () => {
    beforeEach(() => vi.mocked(invoke).mockReset());

    it('real api calls the reserved command names', async () => {
      vi.mocked(invoke).mockResolvedValue({ run_id: 'a1' } as AddAgentRun);
      await addAgentApi.start('kimi');
      await addAgentApi.start('kimi', true);
      await addAgentApi.status('a1');
      await addAgentApi.cancel('a1');
      await addAgentApi.approveInstall('a1');
      expect(vi.mocked(invoke).mock.calls).toEqual([
        ['add_agent_start', { input: 'kimi', terminalOnly: null }],
        ['add_agent_start', { input: 'kimi', terminalOnly: true }],
        ['add_agent_status', { runId: 'a1' }],
        ['add_agent_cancel', { runId: 'a1' }],
        ['add_agent_approve_install', { runId: 'a1' }],
      ]);
    });

    it('listens on the progress event and hands over the whole run', async () => {
      let handler: ((e: { payload: AddAgentRun }) => void) | null = null;
      vi.mocked(listen).mockImplementationOnce((async (_name: string, cb: (e: { payload: AddAgentRun }) => void) => {
        handler = cb;
        return () => undefined;
      }) as never);
      const seen: string[] = [];
      await addAgentApi.onProgress((r) => seen.push(r.run_id));
      handler!({ payload: { run_id: 'z9' } as AddAgentRun });
      expect(vi.mocked(listen).mock.calls.at(-1)?.[0]).toBe('add-agent://progress');
      expect(seen).toEqual(['z9']);
    });
  });
});
