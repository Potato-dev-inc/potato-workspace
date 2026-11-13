// @vitest-environment jsdom
// Screen level, in Traditional Chinese: the sidebar footer's background-tasks chip and the sheet it opens show no English.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneInfo } from '@potato-workspace/shared';
import type { CockpitApi } from '../../hooks/useCockpit';
import { fakeAcpApi } from '../../lib/acpChatFake';
import { tauriJobsApi, type PaneJob } from '../../lib/pane-jobs';
import type { ShipApi } from '../../lib/ship-api';
import { t } from '../../i18n';
import { useChinese, useEnglish, visibleEnglish } from '../../i18n/test-utils';
import { Sidebar } from './Sidebar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  useChinese();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  useEnglish();
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

const job: PaneJob = { pid: 10, parentPid: 1, name: 'node', command: 'node dev', startedAtMs: 1, ports: [3000] };

function cockpit(withPane: boolean) {
  const info = { id: 'p1', agent_type: 'codex', pid: 1, status: 'idle', created_at: 1, last_output_at: null, cwd: 'C:\work\shop', cols: 80, rows: 24, title: null } as unknown as PaneInfo;
  const panes = withPane ? [{ info, status: 'idle' }] : [];
  return {
    chatStarting: null,
    beginChatStart: vi.fn(),
    endChatStart: vi.fn(),
    registry: { paneList: panes, panes: new Map(panes.map((p) => [p.info.id, p])), initialReady: true },
    names: new Map(withPane ? [['p1', 'Codex']] : []),
    asked: { questions: [] },
    launchEntries: [{ type: 'codex', label: 'Codex' }],
    readyAgents: new Set<string>(),
    mode: 'orchestration',
    theme: 'dark',
    selectedId: null,
    select: vi.fn(),
    newAgent: vi.fn(),
    prompts: {},
    statusSince: new Map(withPane ? [['p1', 0]] : []),
    now: 60_000,
    spawn: null,
    toasts: [],
    notify: vi.fn(),
    openSettings: vi.fn(async () => {}),
    bridgeLine: '',
  } as unknown as CockpitApi;
}

const ship = { recent: async () => [], gitState: async () => 'repo' } as unknown as ShipApi;
async function mount(c: CockpitApi) {
  await act(async () => root.render(<Sidebar c={c} onOpenPalette={() => {}} ship={ship} acp={fakeAcpApi({})} />));
  await act(async () => {});
}

describe('the background-tasks chip in Traditional Chinese', () => {
  it('the footer chip counts the tasks in Chinese', async () => {
    vi.spyOn(tauriJobsApi, 'all').mockResolvedValue({ p1: [job, { ...job, pid: 11 }] });
    await mount(cockpit(true));
    const chip = host.querySelector<HTMLElement>('[data-testid="jobs-chip"]')!;
    expect(chip.textContent).toBe(t('state.jobs.count', { count: 2 }));
    expect(chip.getAttribute('title')).toBe(t('state.jobs.chipTitle'));
    expect(visibleEnglish(chip)).toEqual([]);
  });

  it('the sheet it opens, with its Stop and Open buttons, is in Chinese', async () => {
    vi.spyOn(tauriJobsApi, 'all').mockResolvedValue({ p1: [job] });
    await mount(cockpit(true));
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="jobs-chip"]')!.click();
    });
    const sheet = document.querySelector<HTMLElement>('.ck-sheet--jobs')!;
    expect(sheet).not.toBeNull();
    expect(sheet.querySelector('h2')!.textContent).toBe(t('state.jobs.title'));
    expect(sheet.querySelector('.ck-jobs-group-h .ck-job-stop')!.textContent).toBe(t('state.jobs.open'));
    expect(sheet.querySelector('.ck-job .ck-job-stop')!.textContent).toBe(t('state.jobs.stop'));
    await act(async () => {
      sheet.querySelector<HTMLButtonElement>('.ck-job .ck-job-stop')!.click();
    });
    expect(sheet.querySelector('.ck-job-ask')!.textContent).toContain(t('state.jobs.stopAsk'));
    // `node` and `dev` are the job's own name and command (data), localhost is a host name.
    expect(visibleEnglish(sheet, ['node', 'dev', 'localhost', 'shop', 'Shift'])).toEqual([]);
  });
});
