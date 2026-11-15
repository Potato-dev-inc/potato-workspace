// @vitest-environment jsdom
// The one "Update Worker" button: visible steps, a try-again on failure, the hand-off to an agent after three failures.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcpLaneView } from '../../lib/acpChat';
import type { UpdateApi } from '../../lib/workerUpdate';
import { WorkerUpdateButton } from './WorkerUpdateButton';
import { click, settle } from './test-utils';

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
});

const GOOD = { reachable: true, features: ['team', 'stable-link', 'invites'], legacyLink: false };
const VIEW = { labs_enabled: true, agents: [{ id: 'helper', label: 'Helper', lane: 'acp', effective_lane: 'acp' }] } as unknown as AcpLaneView;
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`);
const stepStatus = () => [...host.querySelectorAll('[data-step]')].map((li) => `${li.getAttribute('data-step')}:${li.getAttribute('data-status')}`);

function fake(failStep?: string) {
  const calls: string[] = [];
  const api: UpdateApi = {
    step: async (id) => {
      calls.push(id);
      return id === failStep ? { ok: false, output: 'Error: could not reach the registry' } : { ok: true, output: `${id} output` };
    },
    check: async () => GOOD,
  };
  return { api, calls };
}

async function mount(props: Partial<React.ComponentProps<typeof WorkerUpdateButton>> & { api: UpdateApi }) {
  await act(async () => root.render(<WorkerUpdateButton address="https://pm-relay.me.workers.dev" label="wu.update" pauseMs={0} {...props} />));
}

describe('WorkerUpdateButton', () => {
  it('is one button with a plain label and no command text', async () => {
    await mount({ api: fake().api });
    expect(q('worker-update-go')!.textContent).toBe('Update your link');
    expect(host.textContent).not.toMatch(/wrangler|npm |relay\/worker|cd /);
    await mount({ api: fake().api, label: 'wu.setup' });
    expect(q('worker-update-go')!.textContent).toBe('Set up my phone link');
  });

  it('runs the steps, shows each as done, keeps the output behind Details and calls onDone with the address', async () => {
    const { api } = fake();
    const onDone = vi.fn();
    await mount({ api, onDone });
    await click(q('worker-update-go'));
    await settle(6);
    expect(stepStatus()).toEqual(['prepare:done', 'install:done', 'login:done', 'deploy:done', 'check:done']);
    expect(q('worker-update-done')!.textContent).toContain('up to date');
    expect(host.querySelector('details')!.textContent).toContain('install output');
    expect(onDone).toHaveBeenCalledWith('https://pm-relay.me.workers.dev');
  });

  it('explains the one manual part while the Cloudflare sign-in runs', async () => {
    let release: (v: { ok: boolean; output: string }) => void = () => {};
    const api: UpdateApi = {
      step: (id) => (id === 'login' ? new Promise((r) => (release = r)) : Promise.resolve({ ok: true, output: '' })),
      check: async () => GOOD,
    };
    await mount({ api });
    await click(q('worker-update-go'));
    await settle(4);
    expect(q('worker-update-note-login')!.textContent).toContain('Sign in to Cloudflare there and press Allow');
    await act(async () => release({ ok: true, output: '' }));
    await settle(6);
    expect(q('worker-update-note-login')).toBeNull();
  });

  it('a step that keeps failing is tried 3 times, then "Let Claude fix it" hands it to an agent with the prefilled task', async () => {
    const { api, calls } = fake('install');
    const handOff = vi.fn();
    await mount({ api, loadAgents: async () => VIEW, handOff });
    await click(q('worker-update-go'));
    await settle(8);
    expect(calls.filter((c) => c === 'install')).toHaveLength(3);
    expect(calls).not.toContain('login');
    expect(stepStatus()[1]).toBe('install:failed');
    expect(q('worker-update-failed')!.textContent).toContain('Installing the tool it needs did not work.');
    expect(q('worker-update-failed')!.querySelector('[role="alert"]')!.textContent).not.toContain('could not reach the registry');
    // Nothing is handed over by itself: the person asks for it.
    expect(handOff).not.toHaveBeenCalled();
    expect(q('worker-update-go')!.textContent).toBe('Update your link');
    await click(q('worker-update-fix'));
    await settle(3);
    expect(handOff).toHaveBeenCalledTimes(1);
    const [kind, agentId, task] = handOff.mock.calls[0];
    expect([kind, agentId]).toEqual(['chat', 'helper']);
    expect(task).toContain('Installing the tool it needs');
    expect(task).toContain('could not reach the registry');
    expect(q('worker-update-handed')!.textContent).toContain('Handed over to Helper');
    expect(host.querySelector('[data-testid="worker-update-retry"]')!.textContent).toBe('Try again');
  });

  it('with no chat agent it offers the note to copy instead', async () => {
    const { api } = fake('deploy');
    const handOff = vi.fn();
    Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => undefined) } });
    await mount({ api, loadAgents: async () => null, handOff });
    await click(q('worker-update-go'));
    await settle(8);
    expect(q('worker-update-copy-note')).toBeNull();
    await click(q('worker-update-fix'));
    await settle(3);
    expect(handOff).not.toHaveBeenCalled();
    expect(q('worker-update-copy-note')!.textContent).toContain('No chat agent');
    await click([...host.querySelectorAll('button')].find((b) => b.textContent === 'Copy the note'));
    expect(vi.mocked(navigator.clipboard.writeText).mock.calls[0][0]).toContain('Turning your link on');
  });
});
