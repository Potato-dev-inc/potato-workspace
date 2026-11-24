// @vitest-environment jsdom
// Esc in the palette gives the focus back to what had it before (the composer).
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

describe('Palette: Esc', () => {
  it('returns the focus to the element that had it when the palette opened', () => {
    const composer = document.createElement('textarea');
    document.body.appendChild(composer);
    composer.focus();
    const noop = vi.fn();
    act(() =>
      root.render(
        <Palette c={c} onClose={noop} onUndoLastTurn={noop} onOpenMemory={noop} onOpenTeam={noop} onOpenPlans={noop} onOpenStore={noop} onOpenReview={noop} onOpenShortcuts={noop} />,
      ),
    );
    const input = host.querySelector('input') as HTMLInputElement;
    input.focus();
    expect(document.activeElement).toBe(input);
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(noop).toHaveBeenCalled();
    expect(document.activeElement).toBe(composer);
    composer.remove();
  });

  it('prefers the message box of the open chat over the sidebar row that had the focus', () => {
    const row = document.createElement('button');
    const composer = document.createElement('textarea');
    composer.setAttribute('data-chat-composer', '');
    document.body.append(row, composer);
    row.focus();
    const noop = vi.fn();
    act(() => root.render(<Palette c={c} onClose={noop} onUndoLastTurn={noop} onOpenMemory={noop} onOpenTeam={noop} onOpenPlans={noop} onOpenStore={noop} onOpenReview={noop} onOpenShortcuts={noop} />));
    const input = host.querySelector('input') as HTMLInputElement;
    input.focus();
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(composer);
    row.remove();
    composer.remove();
  });
});
