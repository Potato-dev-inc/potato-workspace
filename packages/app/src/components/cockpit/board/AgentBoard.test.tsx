// @vitest-environment jsdom
// The agent board as a screen: three columns, a click opens the agent, a quick answer only on a low-risk yes/no
// approval, and Esc closes the board. Keys and clicks are real DOM events.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneInfo } from '@potato-workspace/shared';
import type { CockpitApi } from '../../../hooks/useCockpit';
import type { PanePrompt } from '../../../lib/cockpit-api';
import type { NeedsYouItem } from '../../../lib/attention';
import { AgentBoard } from './AgentBoard';

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
  vi.restoreAllMocks();
});

const NOW = 900_000;
const pane = (id: string, status: string) => ({
  info: { id, agent_type: 'claude', pid: 1, status, created_at: 1, last_output_at: null, cwd: 'C:\\work\\shop', cols: 80, rows: 24, title: null } as unknown as PaneInfo,
  status,
});

const LOW_YES_NO = {
  promptId: 'pr1',
  kind: 'permission',
  text: 'Run npm test?',
  choices: [
    { id: 'yes', label: 'Yes' },
    { id: 'no', label: 'No' },
  ],
  risk: { level: 'low' },
} as unknown as PanePrompt;

interface Fixture {
  panes: ReturnType<typeof pane>[];
  prompts?: Record<string, PanePrompt>;
  needsYou?: NeedsYouItem[];
}

function api(f: Fixture) {
  const select = vi.fn();
  const answer = vi.fn(async () => undefined);
  const c = {
    registry: { paneList: f.panes, panes: new Map(f.panes.map((p) => [p.info.id, p])), initialReady: true },
    names: new Map(f.panes.map((p) => [p.info.id, `Agent ${p.info.id}`])),
    prompts: f.prompts ?? {},
    statusSince: new Map(f.panes.map((p) => [p.info.id, NOW - 4 * 60_000])),
    now: NOW,
    select,
    answer,
  } as unknown as CockpitApi;
  return { c, select, answer };
}

function render(f: Fixture, onClose = vi.fn()) {
  const { c, select, answer } = api(f);
  act(() => root.render(<AgentBoard c={c} needsYou={f.needsYou ?? []} onClose={onClose} />));
  return { select, answer, onClose };
}

const column = (name: string) => host.querySelector<HTMLElement>(`.ck-board-col--${name}`)!;

describe('AgentBoard', () => {
  it('shows three columns in order: Needs you, Working, Done', () => {
    render({ panes: [pane('a', 'running'), pane('b', 'waiting_input'), pane('c', 'idle')] });
    const heads = Array.from(host.querySelectorAll('.ck-board-col-head')).map((h) => h.textContent?.replace(/\s*\d+$/, ''));
    expect(heads).toEqual(['Needs you', 'Working', 'Done']);
    expect(column('needs').textContent).toContain('Agent b');
    expect(column('working').textContent).toContain('Agent a');
    expect(column('done').textContent).toContain('Agent c');
  });

  it('shows the time in state on each tile', () => {
    render({ panes: [pane('a', 'running')] });
    expect(column('working').textContent).toContain('for 4 min');
  });

  it('a click on a tile opens that agent', () => {
    const { select } = render({ panes: [pane('a', 'running')] });
    const open = column('working').querySelector<HTMLButtonElement>('.ck-board-open')!;
    act(() => open.click());
    expect(select).toHaveBeenCalledWith('a');
  });

  it('answers a low-risk yes/no approval on the tile', () => {
    const { answer } = render({ panes: [pane('a', 'waiting_input')], prompts: { a: LOW_YES_NO } });
    const yes = Array.from(column('needs').querySelectorAll<HTMLButtonElement>('.ck-board-answer')).find((b) => b.textContent === 'Yes')!;
    act(() => yes.click());
    expect(answer).toHaveBeenCalledTimes(1);
    expect(answer.mock.calls[0].slice(0, 4)).toEqual(['a', 'pr1', 'yes', 'Yes']);
  });

  it('offers no answer on the tile for a risky prompt (the full card opens instead)', () => {
    const risky = { ...LOW_YES_NO, risk: { level: 'high' } } as unknown as PanePrompt;
    render({ panes: [pane('a', 'waiting_input')], prompts: { a: risky } });
    expect(host.querySelector('.ck-board-answers')).toBeNull();
    expect(column('needs').querySelector('.ck-board-open')).not.toBeNull();
  });

  it('closes on Esc, and not while a menu is open over it', () => {
    const { onClose } = render({ panes: [pane('a', 'running')] });
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    document.body.appendChild(menu);
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(onClose).not.toHaveBeenCalled();
    menu.remove();
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows an empty line in a column with no agents', () => {
    render({ panes: [pane('a', 'running')] });
    expect(column('needs').querySelector('.ck-board-empty')?.textContent).toBe('Nobody needs you right now.');
  });
});
