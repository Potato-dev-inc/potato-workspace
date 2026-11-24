// @vitest-environment jsdom
// Run 9 far-chat parity: the owning PC's chat name, the Inbox dismiss that leaves the chat's own card, a file name that cannot travel,
// the Ctrl+K list of far chats, and the shared "files changed" key behind Put back.
import { describe, expect, it, vi } from 'vitest';
import { DevicesFake, MAC_MINI, NODE_MAC } from '../../dev/devices-fixtures';
import { rowOf } from '../../components/devices/useDeviceGroups';
import type { CockpitApi } from '../../hooks/useCockpit';
import { farQuestionsOf } from '../runtime/farQuestions';
import { makePcLinkClient } from '../runtime/pclink';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { paneFilesTouched, usePaneFilesVersion } from '../turn-review';
import { farHost } from './far';
import { farChatName, farCockpit } from './farCockpit';
import { farChatRows } from './farChats';

const session = (extra: Record<string, unknown> = {}) => ({ id: 'p1', agent: 'claude', title: '', status: 'idle', project: 'proj', folder: 'app', chat: true, ...extra }) as never;

describe('the name comes from the owning PC', () => {
  it('uses the number the far PC sent and never renumbers', () => {
    const row = rowOf(NODE_MAC, session({ agent_n: 5, agent_of: 7 }), 'Mac mini');
    expect(farChatName('Claude', row)).toBe('Claude 5');
    expect(farChatName('Claude', rowOf(NODE_MAC, session({ agent_n: 1, agent_of: 1 }), 'Mac mini'))).toBe('Claude');
    expect(farChatName('Claude', rowOf(NODE_MAC, session(), 'Mac mini'))).toBeNull();
    // The far PC keeps a chat's number for its life: "Claude 9" while only two are open is a real answer, "Claude 3" of 2 included.
    expect(farChatName('Claude', rowOf(NODE_MAC, session({ agent_n: 3, agent_of: 2 }), 'Mac mini'))).toBe('Claude 3');
    // A nonsense number from the far PC is ignored.
    expect(rowOf(NODE_MAC, session({ agent_n: 0, agent_of: 2 }), 'Mac mini').nameN).toBeUndefined();
  });

  it('lists far chats for Ctrl+K: not a standby, not a minion, not an offline PC', () => {
    const mk = (extra: Record<string, unknown>) => rowOf(NODE_MAC, session({ id: String(extra.id), ...extra }), 'Mac mini');
    const rows = [mk({ id: 'a', agent_n: 2, agent_of: 3 }), mk({ id: 'b', standby: true }), mk({ id: 'c', started_as: 'minion' }), mk({ id: 'd', chat: false, lane: null })];
    const out = farChatRows([{ device: { name: 'Mac mini', state: 'online' }, rows }], (a) => a.toUpperCase());
    expect(out.map((r) => [r.key, r.title, r.device])).toEqual([[`dev:${NODE_MAC}:a`, 'CLAUDE 2', 'Mac mini']]);
    expect(farChatRows([{ device: { name: 'Mac mini', state: 'offline' }, rows }], (a) => a)).toEqual([]);
  });
});

describe('a far card dismissed from the Inbox stays in its chat', () => {
  it('the chat reads every question, the Inbox only the undismissed ones', () => {
    const fake = new DevicesFake({ enabled: true, devices: [{ ...MAC_MINI, level: 'full' }], panes: { [NODE_MAC]: [] } });
    const client = makePcLinkClient(NODE_MAC, fake);
    const all = farQuestionsOf(NODE_MAC, 'Mac mini', [{ id: 'q1', question: 'Run it?', choices: [{ id: 'yes', label: 'Yes' }], pane_id: 'p1', kind: 'acp_permission' }], () => 1);
    const c = { registry: { panes: new Map(), paneList: [] }, names: new Map(), launchEntries: [], select: vi.fn(), notify: vi.fn() } as unknown as CockpitApi;
    const needs = { questions: [], chatQuestions: all, answer: vi.fn(), hide: vi.fn() };
    const far = farCockpit(c, client, 'Mac mini', [], '', () => undefined, needs);
    expect(far.asked.questions.map((q) => [q.id, q.pane_id])).toEqual([['q1', `dev:${NODE_MAC}:p1`]]);
    expect(farCockpit(c, client, 'Mac mini', [], '', () => undefined, { ...needs, chatQuestions: undefined }).asked.questions).toEqual([]);
  });
});

describe('a chat just started on a far PC', () => {
  it('select opens it by key before the far list shows it (not the Inbox)', () => {
    const fake = new DevicesFake({ enabled: true, devices: [{ ...MAC_MINI, level: 'full' }], panes: { [NODE_MAC]: [] } });
    const client = makePcLinkClient(NODE_MAC, fake);
    const c = { registry: { panes: new Map(), paneList: [] }, names: new Map(), launchEntries: [], select: vi.fn(), notify: vi.fn() } as unknown as CockpitApi;
    const openRow = vi.fn();
    const far = farCockpit(c, client, 'Mac mini', [], '', openRow);
    far.select(`dev:${NODE_MAC}:p9`);
    expect(openRow).toHaveBeenCalledWith(`dev:${NODE_MAC}:p9`);
    far.select('local-1');
    expect(c.select).toHaveBeenCalledWith('local-1');
  });
});

describe('a file name that cannot travel', () => {
  it('says so instead of asking the far PC for a file that is not there', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [{ ...MAC_MINI, level: 'full' }], panes: { [NODE_MAC]: [] } });
    const host = farHost(makePcLinkClient(NODE_MAC, fake), fake, { name: 'Mac mini' });
    await expect(host.invoke('files_read', { paneId: 'dev:x:p1', path: 'caf�.txt' })).rejects.toThrow('Open it on Mac mini');
    expect(fake.requests.some((r) => r.path.includes('files_read'))).toBe(false);
  });
});

describe('Put back', () => {
  it('bumps the key the Changes and Files panels read again on, for that chat only', async () => {
    const seen: number[] = [];
    function Probe() {
      seen.push(usePaneFilesVersion('pb'));
      return null;
    }
    const box = document.createElement('div');
    const root = createRoot(box);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await act(async () => root.render(createElement(Probe)));
    await act(async () => paneFilesTouched('other'));
    await act(async () => paneFilesTouched('pb'));
    expect(seen.at(-1)).toBe(1);
    expect(seen[0]).toBe(0);
    await act(async () => root.unmount());
  });
});

describe('@file in a far chat', () => {
  it('searches on the far PC, and says it when "Browse and copy files" is off there', async () => {
    const { searchProjectFilesOn } = await import('../projectFiles');
    const { t } = await import('../../i18n');
    const calls: unknown[] = [];
    const place = { kind: 'pc', node: NODE_MAC, name: 'Mac mini' } as const;
    const base = { place, live: true, caps: {} as never, listen: async () => () => undefined };
    const ok = { ...base, invoke: (async (cmd: string, args: unknown) => (calls.push([cmd, args]), [{ path: 'a.txt', absPath: '/x/a.txt', name: 'a.txt', size: 1 }])) as never };
    await expect(searchProjectFilesOn(ok)('dev:n:p1', 'a', 8)).resolves.toHaveLength(1);
    expect(calls).toEqual([['project_files_search', { paneId: 'dev:n:p1', query: 'a', limit: 8 }]]);
    const refused = { ...base, invoke: (async () => Promise.reject(new Error(t('pclink.notAllowed')))) as never };
    await expect(searchProjectFilesOn(refused)('dev:n:p1', 'a')).rejects.toThrow('Browse and copy files');
  });
});
