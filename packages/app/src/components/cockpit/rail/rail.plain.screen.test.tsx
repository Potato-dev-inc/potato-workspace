// @vitest-environment jsdom
// Screen-level: the right panel is plain sections (small label, rows, a hairline between), with no Agent row, no
// Context section when the agent reports none, and one line per background task (the command is hover text).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionRail } from './SessionRail';

const chat = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('../../../hooks/useSessionChat', () => ({ useSessionChat: () => chat.current }));
vi.mock('./usePaneBranch', () => ({ usePaneBranch: () => 'main' }));
const jobs = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock('../../../lib/pane-jobs', async (orig) => ({
  ...(await orig<typeof import('../../../lib/pane-jobs')>()),
  usePaneJobs: () => ({ p1: jobs.list }),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  chat.current = { model: null, cliVersion: '9.9', usage: null, plan: [], outputs: [] };
  jobs.list = [
    { pid: 1, parentPid: 0, name: 'node', command: 'node node_modules/vite/bin/vite.js', startedAtMs: Date.now() - 660_000, ports: [5173] },
    { pid: 2, parentPid: 0, name: 'python', command: 'python -m pytest --watch', startedAtMs: Date.now() - 60_000, ports: [] },
  ];
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const props = { paneId: 'p1', status: 'idle', cwd: '/work/billing-service', agentName: 'Codex', readsChat: true, helperOf: null, helpers: [], onOpenPane: () => {} };

describe('plain right panel', () => {
  it('shows Folder and Background as plain sections: no Agent row, no Context, no empty-state sentence', () => {
    act(() => root.render(<SessionRail {...props} />));
    const labels = [...host.querySelectorAll('dt')].map((d) => d.textContent);
    expect(labels).toContain('Folder');
    expect(labels).not.toContain('Agent');
    expect(host.querySelector('[data-testid="rail-context"]')).toBeNull();
    expect(host.textContent).not.toContain('Codex');
    expect(host.querySelectorAll('section.ck-rail-card').length).toBe(2);
    // the "Where" section has no heading of its own; Background keeps its small label
    expect(host.querySelector('[data-testid="rail-where"] h3')).toBeNull();
    expect(host.querySelector('[data-testid="rail-background"] h3')!.textContent).toContain('Background');
  });

  it('each background task is one line; the full command is on hover; Point stays a focusable button', () => {
    act(() => root.render(<SessionRail {...props} />));
    const rows = [...host.querySelectorAll('[data-testid="background-job"]')];
    expect(rows).toHaveLength(2);
    expect(host.querySelector('code')).toBeNull();
    expect(rows[0].querySelector('.ck-job-top')!.getAttribute('title')).toBe('node node_modules/vite/bin/vite.js');
    expect(rows[0].textContent).toContain('node');
    expect(rows[0].textContent).toContain(':5173');
    expect(rows[0].textContent).toContain('11m');
    const point = rows[0].querySelector<HTMLButtonElement>('.ck-job-point')!;
    expect(point.tabIndex).toBe(0);
    expect(point.className).toContain('ck-job-hover');
    expect(rows[1].querySelector('.ck-job-point')).toBeNull();
  });
});
