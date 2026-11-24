// @vitest-environment jsdom
// The Force yes chip in a pane's header: off it is a quiet word that asks first, on it is a visible chip and one click
// turns it off. A chat flips its own switch (`setForceYes`); a terminal pane flips the pane's switch.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcpChatState } from '../../lib/acpChat';
import { useEnglish } from '../../i18n/test-utils';
import { ForceYesChip } from './ForceYesChip';
import { HostProvider } from '../../lib/host/context';
import { ALL_CAPS, type Host } from '../../lib/host/host';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  useEnglish();
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
const chip = () => host.querySelector<HTMLButtonElement>('[data-testid="force-yes-chip"]');
const chatState = (forceYes: boolean, closed = false) => ({ forceYes, closed }) as unknown as AcpChatState;

describe('Force yes chip on a chat', () => {
  it('is a quiet word while off, and clicking it shows the warning without turning anything on', async () => {
    const setForceYes = vi.fn(async () => chatState(true));
    await act(async () => root.render(<ForceYesChip paneId="p1" isAcp state={chatState(false)} agent="fake" cwd="C:\\work" chatApi={{ setForceYes }} />));
    expect(chip()?.textContent).toBe('Force yes');
    expect(chip()?.dataset.on).toBe('false');
    expect(host.querySelector('[data-testid="force-yes-warning"]')).toBeNull();
    await act(async () => chip()!.click());
    const warning = host.querySelector('[data-testid="force-yes-warning"]');
    expect(warning?.textContent).toContain('Risky or destructive asks');
    expect(setForceYes).not.toHaveBeenCalled();
  });

  it('turns on only after the person confirms, and says so on the chip', async () => {
    const setForceYes = vi.fn(async () => chatState(true));
    await act(async () => root.render(<ForceYesChip paneId="p1" isAcp state={chatState(false)} agent="fake" cwd="C:\\work" chatApi={{ setForceYes }} />));
    await act(async () => chip()!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="force-yes-confirm"]')!.click());
    await flush();
    expect(setForceYes).toHaveBeenCalledWith('p1', true);
    expect(chip()?.textContent).toBe('Force yes on');
    expect(chip()?.className).toContain('is-risk');
    expect(host.querySelector('[data-testid="force-yes-warning"]')).toBeNull();
  });

  it('is visible while on, and one click turns it off with no question', async () => {
    const setForceYes = vi.fn(async () => chatState(false));
    await act(async () => root.render(<ForceYesChip paneId="p1" isAcp state={chatState(true)} agent="fake" cwd="C:\\work" chatApi={{ setForceYes }} />));
    expect(chip()?.textContent).toBe('Force yes on');
    await act(async () => chip()!.click());
    await flush();
    expect(setForceYes).toHaveBeenCalledWith('p1', false);
  });

  it('takes the pick back and says why when the app refuses', async () => {
    const setForceYes = vi.fn(async () => {
      throw new Error('PANE_NOT_FOUND: gone');
    });
    await act(async () => root.render(<ForceYesChip paneId="p1" isAcp state={chatState(false)} agent="fake" cwd="C:\\work" chatApi={{ setForceYes }} />));
    await act(async () => chip()!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="force-yes-confirm"]')!.click());
    await flush();
    expect(chip()?.textContent).toBe('Force yes');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('gone');
  });

  it('draws nothing for a chat that has not reported or has closed', async () => {
    await act(async () => root.render(<ForceYesChip paneId="p1" isAcp state={null} agent="fake" cwd="C:\\work" chatApi={{ setForceYes: vi.fn() }} />));
    expect(chip()).toBeNull();
    await act(async () => root.render(<ForceYesChip paneId="p1" isAcp state={chatState(true, true)} agent="fake" cwd="C:\\work" chatApi={{ setForceYes: vi.fn() }} />));
    expect(chip()).toBeNull();
  });
});

describe('Force yes chip on a terminal pane', () => {
  it('reads the pane state and flips the pane switch', async () => {
    const paneForceYes = vi.fn(async () => false);
    const paneSetForceYes = vi.fn(async (_id: string, on: boolean) => on);
    await act(async () => root.render(<ForceYesChip paneId="t1" isAcp={false} state={null} agent="claude" cwd="C:\\work" rulesApi={{ paneForceYes, paneSetForceYes }} />));
    await flush();
    expect(paneForceYes).toHaveBeenCalledWith('t1', 'claude', expect.stringContaining('work'));
    expect(chip()?.textContent).toBe('Force yes');
    await act(async () => chip()!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="force-yes-confirm"]')!.click());
    await flush();
    expect(paneSetForceYes).toHaveBeenCalledWith('t1', true);
    expect(chip()?.textContent).toBe('Force yes on');
  });

  it('shows the chip already on when the agent or a pin starts it that way', async () => {
    await act(async () => root.render(<ForceYesChip paneId="t1" isAcp={false} state={null} agent="claude" cwd="C:\\work" rulesApi={{ paneForceYes: async () => true, paneSetForceYes: async () => false }} />));
    await flush();
    expect(chip()?.textContent).toBe('Force yes on');
  });
});

describe('Force yes chip on a far chat', () => {
  const far = (own: boolean | undefined) => ({ place: { kind: 'pc', node: 'n', name: 'pm-sandbox' }, live: true, caps: ALL_CAPS, forceYesDenied: async () => (own === false ? 'Force yes can only be turned on from pm-sandbox itself.' : null) }) as unknown as Host;
  const render = (own: boolean | undefined, on = false) =>
    act(async () => root.render(<HostProvider host={far(own)}><ForceYesChip paneId="p1" isAcp state={chatState(on)} agent="fake" cwd="/w" chatApi={{ setForceYes: vi.fn() }} /></HostProvider>));

  it('is disabled with the reason and what to do when that PC does not count this one as its own', async () => {
    await render(false);
    await flush();
    expect(chip()?.disabled).toBe(true);
    expect(chip()?.title).toBe('Force yes can only be turned on from pm-sandbox itself.');
  });

  it('stays usable for the person\'s own PC, for an older far PC that does not say, and to turn it off', async () => {
    await render(true);
    await flush();
    expect(chip()?.disabled).toBe(false);
    await render(undefined);
    await flush();
    expect(chip()?.disabled).toBe(false);
    await render(false, true);
    await flush();
    expect(chip()?.disabled).toBe(false);
  });
});
