// @vitest-environment jsdom
// A chat on another PC is the NORMAL pane screen (PaneView) in the host of that PC: the same top bar, view menu, model / effort /
// permission menus and Force yes as a chat on this PC. The far PC's own call table answers the settings (the fake serves the real row
// shapes), the transcript and the message box go over the PC link, and the controls it cannot answer yet are the same controls, disabled.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevicesFake, MAC_MINI, NODE_MAC, type RemotePane } from '../../dev/devices-fixtures';
import { phoneRenderReply } from '../../dev/phone-render-fixture';
import type { CockpitApi } from '../../hooks/useCockpit';
import { farCockpit } from '../../lib/host/farCockpit';
import { makeRemoteClient } from '../../lib/runtime/remote';
import { click, settle } from '../settings/test-utils';
import { FarPane } from './FarPane';
import { rowOf } from './useDeviceGroups';

const localInvokes: { cmd: string; args: unknown }[] = [];
vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string, args?: unknown) => {
    localInvokes.push({ cmd, args });
    return null;
  },
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => undefined, emit: async () => undefined }));
vi.mock('../TerminalViewport', () => ({ TerminalViewport: () => <div data-testid="term" /> }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView = () => {};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  localInvokes.length = 0;
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

const PANE: RemotePane = { id: 'p1', agent_type: 'claude', cwd: '/Users/me/app', status: 'idle', title: 'Build the .dmg', lane: 'acp' };

function fakeCockpit(): CockpitApi {
  return {
    registry: { paneList: [], panes: new Map(), initialReady: true },
    names: new Map(),
    asked: { questions: [] },
    launchEntries: [{ type: 'claude', label: 'Claude' }],
    readyAgents: new Set<string>(),
    mode: 'orchestration',
    theme: 'dark',
    selectedId: null,
    select: vi.fn(),
    interrupt: vi.fn(async () => {}),
    closePane: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    prompts: {},
    activities: {},
    previews: {},
    statusSince: new Map(),
    now: 60_000,
    spawn: null,
    toasts: [],
    notify: vi.fn(),
    bridgeLine: '',
  } as unknown as CockpitApi;
}

async function mount(level: 'watch' | 'answer' | 'full') {
  const fake = new DevicesFake({ enabled: true, devices: [{ ...MAC_MINI, level }], panes: { [NODE_MAC]: [PANE] }, chats: { p1: phoneRenderReply(Date.now()).items } });
  fake.farLevels[NODE_MAC] = level;
  const row = rowOf(NODE_MAC, { id: PANE.id, agent: PANE.agent_type, title: PANE.title, status: PANE.status, project: 'p', folder: 'app', chat: true });
  const c = fakeCockpit();
  await act(async () => root.render(<FarPane device={fake.view.devices[0]!} row={row} rows={[row]} c={c} api={fake} openRow={() => {}} />));
  await settle(14);
  return { fake, c };
}
const q = <T extends Element = HTMLElement>(sel: string) => host.querySelector<T>(sel);
const pill = (chip: string) => q<HTMLButtonElement>(`[data-chip-id="${chip}"] button`);

describe('a chat on another PC is the normal pane screen', () => {
  it('has the local chrome: the top bar with the one badge, the view menu, the three settings menus and Force yes', async () => {
    await mount('full');
    expect(q('[data-testid="pane-place"]')!.textContent).toBe('Mac mini');
    expect(q('.ck-chat-mode-pill')).not.toBeNull();
    for (const id of ['mode', 'model', 'effort']) expect(q(`[data-chip-id="${id}"]`), id).not.toBeNull();
    expect(q('[data-testid="force-yes-chip"]')).not.toBeNull();
    expect(q('[data-testid="chat-composer"]')).not.toBeNull();
    // The chat text comes from the far PC's transcript.
    expect(q('[data-testid="session-chat"]')!.textContent).toContain('create a potato workspace overview page');
    // The old thin screen is gone.
    expect(q('[data-testid="remote-chat"]')).toBeNull();
    expect(q('[data-testid="remote-chips"]')).toBeNull();
  });

  it('Full: a model pick, the effort and Force yes go to the far PC as call rows, and its answer is what shows', async () => {
    const { fake } = await mount('full');
    expect(fake.farCalls.some((x) => x.cmd === 'acp_chat_state' && x.args.paneId === 'p1')).toBe(true);
    await click(pill('model'));
    await click([...document.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent?.includes('Opus 5')));
    await settle(4);
    expect(fake.farCalls.find((x) => x.cmd === 'acp_chat_set_config' && x.args.optionId === 'model')?.args).toMatchObject({ paneId: 'p1', value: 'opus' });
    expect(q('[data-chip-id="model"]')!.textContent).toContain('Opus 5');
    await click([...host.querySelectorAll<HTMLElement>('[data-chip-id="effort"] button')].find((b) => b.textContent?.includes('High')));
    await settle(4);
    expect(fake.farCalls.find((x) => x.cmd === 'acp_chat_set_config' && x.args.optionId === 'effort')?.args).toMatchObject({ paneId: 'p1', value: 'high' });
    await click(q('[data-testid="force-yes-chip"]'));
    await click(q('[data-testid="force-yes-confirm"]'));
    await settle(4);
    expect(fake.farCalls.find((x) => x.cmd === 'acp_chat_set_force_yes')?.args).toMatchObject({ paneId: 'p1', on: true });
    expect(q('[data-testid="force-yes-chip"]')!.getAttribute('data-on')).toBe('true');
  });

  it('Answer and Watch: the same menus, switched off, with the one reason; the message box is the same box, switched off', async () => {
    for (const level of ['answer', 'watch'] as const) {
      await act(async () => root.unmount());
      root = createRoot(host);
      const { fake } = await mount(level);
      expect(pill('model')!.disabled).toBe(true);
      expect(pill('model')!.getAttribute('title') ?? pill('model')!.getAttribute('aria-label') ?? '').toContain('This needs Full on Mac mini.');
      expect(q<HTMLButtonElement>('[data-testid="force-yes-chip"]')!.disabled).toBe(true);
      expect(fake.farCalls.some((x) => x.cmd === 'acp_chat_set_config')).toBe(false);
      expect(q('[data-testid="chat-composer"] textarea')!.hasAttribute('disabled')).toBe(level === 'watch');
    }
  });

  it('a far PC without a row for a command: the control is drawn, disabled, with one reason; nothing is sent for it', async () => {
    const { fake } = await mount('full');
    // Share / Save as page is the chat menu of the local screen; its far row does not exist yet.
    const menu = q('[data-testid="chat-export-menu"], [data-testid="chat-export"]');
    if (menu) expect(menu.hasAttribute('disabled') || menu.getAttribute('aria-disabled') === 'true').toBe(true);
    expect(fake.requests.filter((r) => r.path.startsWith('/pclink/call/')).every((r) => /acp_chat_|agent_model_options|session_chat_|pane_message|chat_earlier|chat_picture|agents_list|agent_lane_get|agent_default_models|agent_rules_effective|project_recent|workflows_|pane_git_branch|pane_open_bundle|artifacts_sync|checkpoint_turn_review|files_|pane_previews|pane_worktree|worktree_|attachment_preview/.test(r.path))).toBe(true);
  });

  // Reads that still ask THIS PC about the far key (they answer "no such pane", nothing is read or written here: a far key names no local
  // pane). Each is a lib that calls Tauri directly; moving it behind the host removes it from this list. The list only shrinks.
  const STILL_ASKED_HERE = ['branch_lineage', 'budget_for_pane', 'chat_draft_get', 'chat_move_status', 'get_pane_remote', 'keep_going_lineage', 'pane_run_info', 'pane_transcript', 'point_take_draft', 'project_budget_status', 'right_size_pending', 'turn_summaries'];
  it('only the pinned local reads still carry the far key (no write, no command that acts), and the list only shrinks', async () => {
    await mount('full');
    const carrying = [...new Set(localInvokes.filter((i) => JSON.stringify(i.args ?? {}).includes('dev:')).map((i) => i.cmd))].sort();
    expect(carrying.filter((c) => !STILL_ASKED_HERE.includes(c))).toEqual([]);
  });

  it('Close goes to the far PC: its DELETE route, then back to this PC', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [{ ...MAC_MINI, level: 'full' }], panes: { [NODE_MAC]: [PANE] } });
    const row = rowOf(NODE_MAC, { id: 'p1', agent: 'claude', title: 'x', status: 'idle', project: 'p', folder: 'app', chat: true });
    const c = fakeCockpit();
    const far = farCockpit(c, makeRemoteClient(NODE_MAC, fake), 'Mac mini', [row], 'Not on Mac mini yet.', () => {});
    // Rename goes to the far PC's `pane_set_title` row, by its own pane id; a refusal says what the far PC said.
    await far.rename(row.key, 'new');
    expect(fake.farCalls.at(-1)).toEqual({ cmd: 'pane_set_title', args: { paneId: 'p1', title: 'new' } });
    expect(c.notify).not.toHaveBeenCalled();
    const old = new DevicesFake({ enabled: true, devices: [{ ...MAC_MINI, level: 'watch' }], panes: { [NODE_MAC]: [PANE] } });
    await farCockpit(c, makeRemoteClient(NODE_MAC, old), 'Mac mini', [row], 'Not on Mac mini yet.', () => {}).rename(row.key, 'new');
    expect(c.notify).toHaveBeenCalledWith('That PC does not let this PC do this. Change it on that PC: Connect > My PCs.');
    await far.closePane(row.key);
    expect(fake.requests.find((r) => r.method === 'DELETE')).toMatchObject({ path: '/pclink/sessions/p1' });
    expect(c.select).toHaveBeenCalledWith(null);
  });
});
