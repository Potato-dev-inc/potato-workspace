// @vitest-environment jsdom
// The crew chip of a workflow's front chat ends its list with "Open live view". Without the prop (every other chat, or the
// Labs switch off) the chip is exactly what it was: no link, and a lone helper still opens at once.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CrewMember } from '../../lib/crew-chip';
import { crewOf, rememberCrewStart } from '../../lib/crew-members';
import { CrewChip } from './CrewChip';

const one: CrewMember[] = [{ id: 'h1', kind: 'minion', title: 'fix login test', agentType: 'claude', state: 'working', startedAt: Date.now() - 5000 }];
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
const chip = () => host.querySelector<HTMLButtonElement>('[data-testid="crew-chip"]')!;
const click = (el: Element) => act(async () => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));

describe('the crew chip of a workflow front', () => {
  it('opens its list even for one helper, and the list ends with Open live view', async () => {
    const onOpen = vi.fn();
    const onOpenLive = vi.fn();
    await act(async () => root.render(<CrewChip members={one} now={Date.now()} onOpen={onOpen} onOpenLive={onOpenLive} />));
    await click(chip());
    expect(onOpen).not.toHaveBeenCalled();
    const link = document.querySelector<HTMLElement>('[data-testid="crew-open-live"]')!;
    expect(link.textContent).toBe('Open live view');
    await click(link);
    expect(onOpenLive).toHaveBeenCalledTimes(1);
  });

  it('is unchanged without it: no link, and a lone helper opens at once', async () => {
    const onOpen = vi.fn();
    await act(async () => root.render(<CrewChip members={one} now={Date.now()} onOpen={onOpen} />));
    await click(chip());
    expect(onOpen).toHaveBeenCalledWith('h1');
    expect(document.querySelector('[data-testid="crew-open-live"]')).toBeNull();
  });
});

describe('remembering the front', () => {
  it('marks only the front chat of a started crew', () => {
    rememberCrewStart('wf', [{ role: 'Front', pane_id: 'p1' }, { role: 'Sonnet', pane_id: 'p2' }], 'Front');
    expect(crewOf('p1')).toEqual({ slug: 'wf', role: 'Front', front: true });
    expect(crewOf('p2')).toEqual({ slug: 'wf', role: 'Sonnet' });
    rememberCrewStart('plain', [{ role: 'Lead', pane_id: 'p3' }]);
    expect(crewOf('p3')?.front).toBeUndefined();
    localStorage.clear();
  });
});
