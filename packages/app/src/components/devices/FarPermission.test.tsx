// @vitest-environment jsdom
// A far chat that waits on a tool permission: the whole live path (the far PC's `/pclink/questions` through the real device-groups
// hook, the Needs context, FarPane, the dock) draws the same permission card as a local chat, and Yes goes to that PC.
import { act, useContext } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevicesFake, MAC_MINI, NODE_MAC, farChatState, type RemotePane } from '../../dev/devices-fixtures';
import { FarNeedsContext, type FarNeeds } from '../../hooks/useNeedsYou';
import type { CockpitApi } from '../../hooks/useCockpit';
import { settle } from '../settings/test-utils';
import { FarPane } from './FarPane';
import { useDeviceGroups } from './useDeviceGroups';

vi.mock('@tauri-apps/api/core', () => ({ invoke: async () => null }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => undefined, emit: async () => undefined }));

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

const PANE: RemotePane = { id: 'p1', agent_type: 'claude', cwd: '/home/pm/work', status: 'waiting_input', title: 'Write a file', lane: 'acp' };
const c = {
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

/** What CockpitApp does: one device-groups hook, its questions shared by context, the far chat opened inside it. */
function Harness({ api }: { api: DevicesFake }) {
  const groups = useDeviceGroups(api);
  const needs: FarNeeds = { questions: groups.questions, answer: groups.answerQuestion, hide: groups.hideQuestion };
  const row = groups.groups.flatMap((g) => g.rows)[0];
  const device = groups.view?.devices[0];
  return <FarNeedsContext.Provider value={needs}>{row && device ? <FarPane device={device} row={row} rows={[row]} c={c} api={api} openRow={() => {}} /> : null}</FarNeedsContext.Provider>;
}

async function scene(question: Record<string, unknown>) {
  const fake = new DevicesFake({ enabled: true, devices: [{ ...MAC_MINI, level: 'full' }], panes: { [NODE_MAC]: [PANE] } });
  fake.farLevels[NODE_MAC] = 'full';
  fake.chatStates.p1 = farChatState('p1', {
    phase: 'needs_input',
    status: 'waiting_input',
    turnInFlight: true,
    permissions: [{ askId: 1, title: 'Write perm-test.txt', toolKind: 'edit', questionId: 'q1', options: [{ id: 'allow', name: 'Yes', kind: 'allow_once' }, { id: 'reject', name: 'No', kind: 'reject_once' }], sinceMs: 1 }],
  });
  fake.questionsOf[NODE_MAC] = [{ id: 'q1', question: 'Claude asks permission: Write perm-test.txt', choices: [{ id: 'allow', label: 'Yes' }, { id: 'reject', label: 'No' }], allow_free_text: false, ...question } as never];
  await act(async () => root.render(<Harness api={fake} />));
  await settle(30);
  return fake;
}

async function yesAnswersTheFarPc(fake: DevicesFake) {
  const card = host.querySelector('[data-testid="decision-card"]');
  expect(card, host.querySelector('[data-testid="acp-dock"]')?.textContent ?? 'no dock').toBeTruthy();
  expect(host.textContent).not.toContain("didn't say what for");
  await act(async () => [...card!.querySelectorAll('button')].find((b) => b.textContent === 'Yes')!.click());
  await settle(6);
  expect(fake.answeredQuestions).toEqual([{ node: NODE_MAC, id: 'q1', answer: { choice_id: 'allow' } }]);
}

describe('a far chat that waits on a tool permission (live path)', () => {
  it('draws the far question as the permission card in the chat dock, and Yes answers it on that PC', async () => {
    await yesAnswersTheFarPc(await scene({ pane_id: 'p1', kind: 'acp_permission' }));
  });

  it('still draws it when the far list does not say which chat or kind (the chat state names the card)', async () => {
    await yesAnswersTheFarPc(await scene({}));
  });
});
