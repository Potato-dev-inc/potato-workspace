// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneInfo } from '../../lib/tauri-types';
import { EndedAgentsLine } from './EndedAgentsLine';
import { FORGET_DELAY_MS, useSessionMemory, type SessionMemoryApi } from './useSessionMemory';
import { readSessionMemory, writeSessionMemory } from './session-memory';

const tabs = vi.hoisted(() => new Map<string, string>());
vi.mock('./PaneView', () => ({
  rememberedTabOf: (id: string) => tabs.get(id),
  seedRememberedTab: (id: string, tab?: string) => void (tab && tabs.set(id, tab)),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const info = (id: string, extra: Partial<PaneInfo> = {}): PaneInfo => ({
  id, agent_type: 'claude', pid: 1, status: 'idle', created_at: 0, last_output_at: null, cwd: `C:\\${id}`, cols: 80, rows: 24, ...extra,
});
const paneMap = (...infos: PaneInfo[]) => new Map(infos.map((i) => [i.id, { info: i }]));

let host: HTMLDivElement;
let root: Root;
let api: SessionMemoryApi;
const select = vi.fn();
const newAgent = vi.fn(async () => 'new-1' as string | null);

function Probe(p: { ready: boolean; selectedId: string | null; panes: ReturnType<typeof paneMap> }) {
  api = useSessionMemory({ ...p, select, newAgent });
  return createElement(EndedAgentsLine, { ended: api.ended, onReopen: api.reopen, onDismiss: api.dismiss });
}
const render = (p: Parameters<typeof Probe>[0]) => act(() => root.render(createElement(Probe, p)));
const press = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label)!.click();

beforeEach(() => {
  localStorage.clear();
  tabs.clear();
  select.mockClear();
  newAgent.mockClear();
  vi.useFakeTimers();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe('useSessionMemory', () => {
  it('selects the remembered pane on its tab when it still exists', () => {
    writeSessionMemory({ selected: { id: 'p2', tab: 'changes' }, terminals: [] });
    render({ ready: true, selectedId: null, panes: paneMap(info('p1'), info('p2')) });
    expect(api.restoreSelection()).toBe(true);
    expect(select).toHaveBeenCalledWith('p2');
    expect(tabs.get('p2')).toBe('changes');
  });

  it('does nothing when the remembered pane is gone', () => {
    writeSessionMemory({ selected: { id: 'gone' }, terminals: [] });
    render({ ready: true, selectedId: null, panes: paneMap(info('p1')) });
    expect(api.restoreSelection()).toBe(false);
    expect(select).not.toHaveBeenCalled();
  });

  it('does nothing and shows no line when the saved text is corrupt', () => {
    localStorage.setItem('pm.cockpit.session', '{broken');
    render({ ready: true, selectedId: null, panes: paneMap(info('p1')) });
    expect(api.restoreSelection()).toBe(false);
    expect(host.textContent).toBe('');
  });

  it('says how many terminal agents ended, and Reopen starts each in its folder', async () => {
    writeSessionMemory({
      selected: null,
      terminals: [{ id: 'a', agent: 'claude', cwd: 'C:\\a' }, { id: 'b', agent: 'codex', cwd: 'C:\\b', account: 'acc1' }, { id: 'live', agent: 'claude', cwd: 'C:\\live' }],
    });
    render({ ready: true, selectedId: null, panes: paneMap(info('live')) });
    expect(host.textContent).toContain('2 terminal agents ended with the last restart.');
    await act(async () => press('Reopen'));
    expect(newAgent).toHaveBeenNthCalledWith(1, 'claude', undefined, false, 'C:\\a', undefined, 'terminal');
    expect(newAgent).toHaveBeenNthCalledWith(2, 'codex', 'acc1', false, 'C:\\b', undefined, 'terminal');
    expect(host.textContent).not.toContain('ended with the last restart');
  });

  it('keeps an agent in the line when it could not be reopened', async () => {
    writeSessionMemory({ selected: null, terminals: [{ id: 'a', agent: 'claude', cwd: 'C:\\a' }] });
    newAgent.mockResolvedValueOnce(null);
    render({ ready: true, selectedId: null, panes: paneMap() });
    await act(async () => press('Reopen'));
    expect(host.textContent).toContain('1 terminal agent ended');
  });

  it('the ended line is inset from the sidebar edge, so its first character is not clipped', () => {
    writeSessionMemory({ selected: null, terminals: [{ id: 'a', agent: 'claude', cwd: 'C:\\a' }] });
    render({ ready: true, selectedId: null, panes: paneMap() });
    const line = host.querySelector<HTMLElement>('.ck-ended');
    expect(line?.textContent).toContain('1 terminal agent ended with the last restart.');
    const css = readFileSync(join(__dirname, '../../styles/ended-agents-line.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = /\.cockpit \.ck-ended \{([^}]*)\}/.exec(css);
    expect(rule).not.toBeNull();
    const left = Number(/padding:\s*\d+px\s+(\d+)px/.exec(rule![1])?.[1] ?? 0);
    expect(left).toBeGreaterThanOrEqual(12);
  });

  it('Dismiss hides the line and later forgets those agents', () => {
    writeSessionMemory({ selected: null, terminals: [{ id: 'a', agent: 'claude', cwd: 'C:\\a' }] });
    render({ ready: true, selectedId: null, panes: paneMap() });
    act(() => press('Dismiss'));
    expect(host.textContent).toBe('');
    act(() => void vi.advanceTimersByTime(FORGET_DELAY_MS + 10));
    expect(readSessionMemory().terminals).toEqual([]);
  });

  it('writes open terminals at once, but waits before forgetting one that vanished', () => {
    render({ ready: true, selectedId: null, panes: paneMap(info('p1'), info('p2')) });
    expect(readSessionMemory().terminals.map((t) => t.id)).toEqual(['p1', 'p2']);
    render({ ready: true, selectedId: null, panes: paneMap(info('p1')) });
    expect(readSessionMemory().terminals.map((t) => t.id)).toEqual(['p1', 'p2']);
    act(() => void vi.advanceTimersByTime(FORGET_DELAY_MS + 10));
    expect(readSessionMemory().terminals.map((t) => t.id)).toEqual(['p1']);
  });

  it('a run that was killed (panes never closed) still leaves the ended line and Reopen for the next start', async () => {
    // First run: two terminals open, stored at once. The app is then killed, so no pane ever vanishes in the list.
    render({ ready: true, selectedId: null, panes: paneMap(info('p1'), info('p2', { agent_type: 'codex' })) });
    expect(readSessionMemory().terminals.map((t) => t.id)).toEqual(['p1', 'p2']);
    act(() => root.unmount());
    host.remove();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    // Next start: the agents were ended by the job object, the pane list is empty.
    render({ ready: true, selectedId: null, panes: paneMap() });
    expect(host.textContent).toContain('2 terminal agents ended with the last restart.');
    await act(async () => press('Reopen'));
    expect(newAgent).toHaveBeenNthCalledWith(1, 'claude', undefined, false, 'C:\\p1', undefined, 'terminal');
    expect(newAgent).toHaveBeenNthCalledWith(2, 'codex', undefined, false, 'C:\\p2', undefined, 'terminal');
  });

  it('writes the selection only after the restore ran', () => {
    writeSessionMemory({ selected: { id: 'p1', tab: 'chat' }, terminals: [] });
    render({ ready: true, selectedId: null, panes: paneMap(info('p1')) });
    expect(readSessionMemory().selected).toEqual({ id: 'p1', tab: 'chat' });
    act(() => void api.restoreSelection());
    render({ ready: true, selectedId: 'p1', panes: paneMap(info('p1')) });
    expect(readSessionMemory().selected).toEqual({ id: 'p1', tab: 'chat' });
    render({ ready: true, selectedId: null, panes: paneMap(info('p1')) });
    expect(readSessionMemory().selected).toBeNull();
  });
});
