// @vitest-environment jsdom
// Sameness guard, sidebar half (P2.4). One session registry (a workflow's front with its helpers, a minion, a standby's own chat, a chat on a
// separate copy, an agent with no title) is drawn twice by the REAL Sidebar: from this PC's own pane list, and as another PC's project from
// that PC's `GET /pclink/sessions` rows (the fixture goes through JSON). The chat list must read the same: the same names, the same second
// lines, the same nesting under the front, the workflow row, the "N helpers" chip, and nothing shown that this PC's own sidebar hides.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevicesFake, MAC_MINI, NODE_MAC, PM_NIGHT_PANES as FAR } from '../../dev/devices-fixtures';
import type { CockpitApi } from '../../hooks/useCockpit';
import { paneNames } from '../../components/cockpit/model';
import { Sidebar } from '../../components/cockpit/Sidebar';
import { useDeviceGroups } from '../../components/devices/useDeviceGroups';
import { rememberCrewStart } from '../../lib/crew-members';
import type { ShipApi } from '../../lib/ship-api';

vi.mock('../../lib/settings', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/settings')>();
  return { ...real, loadSettings: async () => ({ ...(await real.loadSettings()), workflows_enabled: true }) };
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView = () => {};

const COPY_CWD = '/w/pm-night/.potato-workspace/worktrees/fix-1';
// Its own sidebar hides a standby's own chat through its standby list (the helper row sits under its owner); the far rows say it with `standby`.
// The standby ROWS under an owner are not drawn for another PC (its standby list does not travel).
const LOCAL = FAR.filter((p) => !p.standby_seat).map((p) => ({
  info: {
    id: p.id, agent_type: p.agent_type, pid: 1, status: p.status, created_at: 1, last_output_at: null, cwd: p.copy ? COPY_CWD : p.cwd, cols: 80, rows: 24, title: p.title || null, lane: 'acp',
    ...(p.parent_pane_id ? { parent_pane_id: p.parent_pane_id } : {}), ...(p.started_as ? { started_as: p.started_as } : {}), ...(p.standby_seat ? { standby_seat: p.standby_seat } : {}),
  },
  status: p.status,
}));
const ENTRIES = [{ type: 'claude', label: 'Claude' }, { type: 'opencode', label: 'OpenCode' }];

function cockpit(list: typeof LOCAL): CockpitApi {
  return {
    registry: { paneList: list, panes: new Map(list.map((p) => [p.info.id, p])), initialReady: true },
    names: paneNames(list as never, (id) => ENTRIES.find((e) => e.type === id)?.label ?? id),
    asked: { questions: [] }, launchEntries: ENTRIES, readyAgents: new Set<string>(), mode: 'orchestration', theme: 'dark',
    selectedId: null, select: vi.fn(), prompts: {}, statusSince: new Map(), now: 60_000, spawn: null, notify: vi.fn(),
    setMode: vi.fn(async () => {}), toggleTheme: vi.fn(async () => {}), openSettings: vi.fn(async () => {}), bridgeLine: '',
  } as unknown as CockpitApi;
}
const ship = { recent: vi.fn().mockResolvedValue([]), gitState: vi.fn().mockResolvedValue('repo') } as unknown as ShipApi;

function FarScreen({ fake }: { fake: DevicesFake }) {
  const groups = useDeviceGroups(fake);
  return <Sidebar c={cockpit([])} onOpenPalette={() => {}} ship={ship} devices={groups.enabled ? { groups: groups.groups, selectedKey: null, onOpen: () => {}, onRetry: groups.refresh } : undefined} />;
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
const flush = async () => {
  for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

/** The chat list of a project, as a reader sees it: every row (depth, name, second line, nested mark), chip and workflow row in order. */
function outline(project: Element): string[] {
  const out: string[] = [];
  for (const el of project.querySelectorAll<HTMLElement>('[data-pane-row], [data-testid="workflow-row"], .ck-helper-chip')) {
    const depth = (() => { let d = 0; for (let n = el.parentElement; n && n !== project; n = n.parentElement) if (n.classList.contains('ck-helpers')) d++; return d; })();
    const text = el.matches('.ck-helper-chip') ? `chip ${el.textContent}` : el.matches('[data-testid="workflow-row"]') ? `workflow ${el.textContent}` : `row ${el.querySelector('.ck-row-title')?.textContent} | ${el.querySelector('.ck-row-sub')?.textContent}${el.querySelector('[data-testid="row-spinoff-mark"]') ? ' | spin-off' : ''}${el.querySelector('.ck-row-pill--error') ? ' | error' : ''}`;
    out.push(`${'  '.repeat(depth)}${text}`);
  }
  return out;
}

describe('sidebar: a far PC lists its chats exactly as its own sidebar does', () => {
  it('the same registry gives the same chat list (names, nesting, workflow row, hidden standby and minion, copy)', async () => {
    // This PC's own sidebar.
    rememberCrewStart('wf', [{ role: 'Front', pane_id: 'front' }], 'Front', 'Research + Write');
    await act(async () => root.render(<Sidebar c={cockpit(LOCAL)} onOpenPalette={() => {}} ship={ship} />));
    await flush();
    const local = outline(host.querySelector('.ck-proj')!);
    await act(async () => root.render(<div />));
    // Another PC's: nothing of the mark lives in this PC's browser storage any more; the row says it.
    localStorage.clear();
    const fake = new DevicesFake({ enabled: true, devices: [MAC_MINI], panes: { [NODE_MAC]: FAR } });
    await act(async () => root.render(<FarScreen fake={fake} />));
    await flush();
    const far = outline(host.querySelector(`.ck-proj[data-remote-node="${NODE_MAC}"]`)!);

    expect(local.length).toBeGreaterThan(5);
    expect(far).toEqual(local);
    // And it is the registry we meant: names numbered like on its own PC, the workflow row, no standby or minion.
    expect(local.join('\n')).toContain('workflow Workflow: Research + Write');
    expect(local.join('\n')).toContain('OpenCode 1');
    expect(local.join('\n')).toContain('separate copy of pm-night');
    expect(local.join('\n')).not.toContain('Standby');
    expect(local.join('\n')).not.toContain('Scratch');
  });
});
