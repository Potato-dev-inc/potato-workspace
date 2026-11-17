// @vitest-environment jsdom
// "Get standbys ready now": the button is off (and the message says what to do) when no role has a number or no folder is
// picked, the sheet is drawn on the page itself (not clipped inside the canvas), it explains itself, and after the click it
// lists what was created or says that nothing was.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Crew, CrewApplied } from '../../lib/crews-api';
import { ApplySheet } from './ApplySheet';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const crewWith = (standbys: number) =>
  ({ name: 'Crew', routing_file: 'x.md', roles: [{ id: 'lead', name: 'Lead', agent_type: 'claude', task: 't', standbys, permissions: {} }] }) as unknown as Crew;
const applied = (extra: Partial<CrewApplied>): CrewApplied => ({ added: [], already: 0, skipped: [], needs_limit: null, problems: [], ...extra });
const btn = (label: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement | undefined;

function show(crew: Crew, apply: (c: Crew, f: string, r?: boolean) => Promise<CrewApplied>, folder: string | null) {
  act(() => root.render(<ApplySheet crew={crew} api={{ apply }} ship={{ pickFolder: vi.fn(async () => ({ path: 'D:/x', name: 'x', state: 'ok', last_used_ms: 0 } as never)) }} defaultFolder={folder} onClose={vi.fn()} />));
}

describe('ApplySheet', () => {
  it('with no number on any role: the button is off and the message says what to do', () => {
    show(crewWith(0), vi.fn(), 'D:/x');
    expect(btn('Get them ready')!.disabled).toBe(true);
    expect(document.querySelector('[data-testid="apply-none"]')!.textContent).toMatch(/set "Standbys to get ready now" to 1 or more/);
    expect(document.querySelector('.crewc-folder')).toBeNull();
  });

  it('is drawn on the page, not inside the canvas, and explains what a standby is', () => {
    show(crewWith(2), vi.fn(), null);
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(host.contains(dialog)).toBe(false);
    expect(dialog.textContent).toContain('already started and waiting');
    expect(btn('Get them ready')!.disabled).toBe(true);
    expect(document.querySelector('[data-testid="apply-why-off"]')!.textContent).toBe('Pick a folder to turn the button on.');
  });

  it('lists the standbys it created', async () => {
    const apply = vi.fn(async () => applied({ added: ['Reviewer', 'Tester'] }));
    show(crewWith(2), apply, 'D:/x');
    expect(btn('Get them ready')!.disabled).toBe(false);
    await act(async () => btn('Get them ready')!.click());
    const text = document.querySelector('[data-testid="apply-result"]')!.textContent!;
    expect(text).toContain('2 standbys were set up.');
    expect(text).toContain('Reviewer');
    expect(text).toContain('Tester');
  });

  it('shows what each new standby is doing, including one that cannot start', async () => {
    const standbyApi = { get: vi.fn(async () => ({ helpers: [{ id: 'a', name: 'Reviewer', project: 'D:/x', state: 'problem', note: 'needs_chat' }, { id: 'b', name: 'Tester', project: 'D:/x', state: 'ready', note: null }], max: 4, idle_minutes: 30 })) } as never;
    const apply = vi.fn(async () => applied({ added: ['Reviewer', 'Tester'] }));
    act(() => root.render(<ApplySheet crew={crewWith(2)} api={{ apply }} ship={{ pickFolder: vi.fn() }} defaultFolder="D:/x" onClose={vi.fn()} standbyApi={standbyApi} />));
    for (let i = 0; i < 3; i++) await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
    await act(async () => btn('Get them ready')!.click());
    const lines = [...document.querySelectorAll('[data-testid="apply-made"]')].map((l) => l.textContent);
    expect(lines).toEqual(["Reviewer · Can't start · This agent needs Chat turned on to wait on standby. Turn it on in Settings > Agents, on that agent.", 'Tester · Ready']);
  });

  it('keys a standby by role name and folder: the same role in another folder is not the one shown', async () => {
    const standbyApi = { get: vi.fn(async () => ({ helpers: [{ id: 'a', name: 'Reviewer', project: 'D:/other', state: 'problem', note: 'needs_chat' }, { id: 'b', name: 'Reviewer', project: 'D:/x/', state: 'ready', note: null }], max: 4, idle_minutes: 30 })) } as never;
    const apply = vi.fn(async () => applied({ added: ['Reviewer'] }));
    act(() => root.render(<ApplySheet crew={crewWith(1)} api={{ apply }} ship={{ pickFolder: vi.fn() }} defaultFolder="D:/x" onClose={vi.fn()} standbyApi={standbyApi} />));
    for (let i = 0; i < 3; i++) await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
    await act(async () => btn('Get them ready')!.click());
    expect([...document.querySelectorAll('[data-testid="apply-made"]')].map((l) => l.textContent)).toEqual(['Reviewer · Ready']);
  });

  it('says clearly when nothing was created, with the reason', async () => {
    const apply = vi.fn(async () => applied({ skipped: [{ role: 'Reviewer', why: 'This agent cannot wait ready in the background.' }] }));
    show(crewWith(1), apply, 'D:/x');
    await act(async () => btn('Get them ready')!.click());
    const text = document.querySelector('[data-testid="apply-result"]')!.textContent!;
    expect(text).toContain('Nothing was created.');
    expect(text).toContain('Reviewer: This agent cannot wait ready');
  });

  it('after standbys are made it says what happens next, and can open Start crew', async () => {
    const onStartCrew = vi.fn();
    const onClose = vi.fn();
    const apply = vi.fn(async () => applied({ added: ['Reviewer'] }));
    act(() => root.render(<ApplySheet crew={crewWith(1)} api={{ apply }} ship={{ pickFolder: vi.fn() }} defaultFolder="D:/x" onClose={onClose} onStartCrew={onStartCrew} />));
    expect(document.querySelector('[data-testid="apply-next"]')).toBeNull();
    await act(async () => btn('Get them ready')!.click());
    const next = document.querySelector('[data-testid="apply-next"]')!.textContent!;
    expect(next).toContain('nothing runs yet');
    expect(next).toContain('used up');
    await act(async () => btn('Start this crew…')!.click());
    expect(onClose).toHaveBeenCalled();
    expect(onStartCrew).toHaveBeenCalledTimes(1);
  });

  it('nothing created: no next-steps line and no start button', async () => {
    const apply = vi.fn(async () => applied({ added: [], already: 1 }));
    show(crewWith(1), apply, 'D:/x');
    await act(async () => btn('Get them ready')!.click());
    expect(document.querySelector('[data-testid="apply-next"]')).toBeNull();
    expect(btn('Start this crew…')).toBeUndefined();
  });
});
