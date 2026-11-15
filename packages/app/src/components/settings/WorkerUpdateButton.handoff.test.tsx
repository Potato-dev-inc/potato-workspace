// @vitest-environment jsdom
// Screen level: three failed tries hand the job to a chat agent through the real hand-off host, even when the person's
// agents are saved to run in the terminal ("No chat agent is set up yet" was shown for them).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcpLaneView } from '../../lib/acpChat';
import { readDraft } from '../../lib/composerDraft';
import type { UpdateApi } from '../../lib/workerUpdate';
import { AddAgentActionHost } from '../cockpit/AddAgentActionHost';
import { WorkerUpdateButton } from './WorkerUpdateButton';
import { click, settle } from './test-utils';

vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn(async () => undefined), listen: vi.fn(async () => () => undefined) }));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const agent = (id: string) => ({ id, label: id, lane: 'terminal', effective_lane: 'terminal', disabled: false });
const VIEW = { labs_enabled: true, agents: [agent('claude'), agent('codex')] } as unknown as AcpLaneView;
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`);

it('opens a chat with the prefilled task for the agent used last, though no agent is saved as a chat', async () => {
  localStorage.setItem('pm.newagent.agent', 'codex:work');
  const select = vi.fn();
  const startChat = vi.fn(async () => 'pane-9');
  const c = { newAgent: vi.fn(), select, notify: vi.fn() };
  const api: UpdateApi = { step: async (id) => (id === 'install' ? { ok: false, output: 'EISDIR lstat C:' } : { ok: true, output: '' }), check: async () => ({ reachable: true, features: [], legacyLink: false }) };
  await act(async () =>
    root.render(
      <>
        <AddAgentActionHost c={c as never} folder="/work/demo" startChat={startChat} />
        <WorkerUpdateButton address={null} label="wu.setup" api={api} loadAgents={async () => VIEW} pauseMs={0} />
      </>,
    ),
  );
  await click(q('worker-update-go'));
  await settle(10);
  expect(q('worker-update-copy-note')).toBeNull();
  expect(q('worker-update-handed')).toBeNull();
  await click(q('worker-update-fix'));
  await settle(4);
  expect(q('worker-update-copy-note')).toBeNull();
  expect(q('worker-update-handed')!.textContent).toContain('codex');
  expect(startChat).toHaveBeenCalledWith('codex', '/work/demo');
  expect(readDraft('pane-9')).toContain('EISDIR lstat C:');
  expect(select).toHaveBeenCalledWith('pane-9');
});
