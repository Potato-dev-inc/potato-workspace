// @vitest-environment jsdom
// The palette never lists the same place twice: one row per (title, what it opens).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import { Palette } from './Palette';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const c = {
  registry: { paneList: [], panes: new Map([['p1', {}]]) },
  launchEntries: [],
  readyAgents: new Set(),
  names: new Map([['p1', 'Claude']]),
  selectedId: 'p1',
  mode: 'orchestration',
  theme: 'dark',
  interrupt: vi.fn(),
  openSettings: vi.fn(),
  notify: vi.fn(),
} as unknown as CockpitApi;

function rowsFor(text: string): string[] {
  const input = host.querySelector('input') as HTMLInputElement;
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    set.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return Array.from(host.querySelectorAll('[role="option"]')).map((r) => r.textContent ?? '');
}

describe('Palette: no repeated rows', () => {
  it('lists each row once for common words', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const noop = vi.fn();
    act(() =>
      root.render(
        <Palette c={c} onClose={noop} onUndoLastTurn={noop} onOpenMemory={noop} onOpenTeam={noop} onOpenPlans={noop} onOpenStore={noop} onOpenReview={noop} onOpenShortcuts={noop} />,
      ),
    );
    // A repeated row id used to leave stale copies of one row on screen ("memory" showed Team four times).
    for (const word of ['', 'memory', 'team', 'team', 'phone', 'keys', 'agent', 'sign in']) {
      const rows = rowsFor(word);
      expect(new Set(rows).size, `"${word}": ${JSON.stringify(rows)}`).toBe(rows.length);
    }
    const keyWarnings = warn.mock.calls.filter((a) => String(a[0]).includes('same key'));
    expect(keyWarnings).toHaveLength(0);
    warn.mockRestore();
  });
});
