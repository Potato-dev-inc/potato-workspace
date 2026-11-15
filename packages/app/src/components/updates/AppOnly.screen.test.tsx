// @vitest-environment jsdom
// App-only updates at screen level, through the real parents (the update notice host and the Settings version row):
// the offer names its size, the steps show above the progress, the missing-tools line offers Repair, and Settings always
// has a Repair button. Nothing here is a component rendered alone.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolsStatus, UpdateOffer, UpdateStep, UpdateTransport } from '../../lib/app-update';
import { buttonByText, click, hasText, settle } from '../settings/test-utils';
import { UpdateRow } from '../settings/sections/UpdateRow';
import { AppUpdateHost } from './AppUpdateHost';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = host = undefined;
});

const SMALL: UpdateOffer = { currentVersion: '1.2.0', version: '1.2.1', notes: null, size: 39_000_000, newTools: false, smaller: true };
const BIG_NEW_TOOLS: UpdateOffer = { currentVersion: '1.2.0', version: '1.2.2', notes: null, size: 138_000_000, newTools: true, smaller: false };
const OK: ToolsStatus = { ok: true, source: 'install', toolsVersion: 1 };
const MISSING: ToolsStatus = { ok: false, source: 'missing', toolsVersion: 1 };

function transport(over: Partial<UpdateTransport> = {}) {
  return {
    check: vi.fn(async () => SMALL as UpdateOffer | null),
    busy: vi.fn(async () => [] as string[]),
    install: vi.fn(async (_confirm: boolean) => undefined),
    toolsStatus: vi.fn(async () => OK),
    repairTools: vi.fn(async (_confirm: boolean) => undefined),
    ...over,
  } as UpdateTransport & { install: ReturnType<typeof vi.fn>; repairTools: ReturnType<typeof vi.fn> };
}

async function mount(node: React.ReactElement) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(node));
  await settle(6);
  return host;
}

describe('the offer names the real size', () => {
  it('says the size of the small download', async () => {
    const h = await mount(<AppUpdateHost transport={transport()} />);
    expect(hasText(h, 'Update available: 1.2.1 (39 MB)')).toBe(true);
  });

  it('says when the full download brings new built-in tools', async () => {
    const h = await mount(<AppUpdateHost transport={transport({ check: vi.fn(async () => BIG_NEW_TOOLS) })} />);
    expect(hasText(h, 'Update available: 1.2.2 (138 MB, includes new built-in tools)')).toBe(true);
  });

  it('keeps the old line for a release that does not say its size', async () => {
    const plain: UpdateOffer = { currentVersion: '1.1.1', version: '1.1.2', notes: null };
    const h = await mount(<AppUpdateHost transport={transport({ check: vi.fn(async () => plain) })} />);
    expect(hasText(h, 'Update available: 1.1.2')).toBe(true);
    expect(hasText(h, ' MB)')).toBe(false);
  });
});

describe('the steps above the progress', () => {
  it('shows "Getting ready…" while the tools are copied and the fallback line when the full update is used', async () => {
    let step: (s: UpdateStep) => void = () => undefined;
    let finish: () => void = () => undefined;
    const t = transport({
      onStep: vi.fn(async (cb) => {
        step = cb;
        return () => undefined;
      }),
      install: vi.fn(() => new Promise<void>((resolve) => (finish = resolve))),
    });
    const h = await mount(<AppUpdateHost transport={t} />);
    await click(buttonByText(h, 'Update'));
    await settle();
    await act(async () => step('preparing'));
    expect(h.querySelector('[data-testid="update-step"]')?.textContent).toBe('Getting ready…');
    await act(async () => step('fallback'));
    expect(h.querySelector('[data-testid="update-step"]')?.textContent).toBe('Getting the full update instead.');
    await act(async () => finish());
    await settle();
  });
});

describe('the missing-tools line', () => {
  it('is quiet when the tools are in place', async () => {
    const h = await mount(<AppUpdateHost transport={transport({ check: vi.fn(async () => null) })} />);
    expect(h.querySelector('[data-testid="tools-missing"]')).toBeNull();
  });

  it('says so in one line with a Repair button, and Repair asks the app to repair', async () => {
    const t = transport({ check: vi.fn(async () => null), toolsStatus: vi.fn(async () => MISSING) });
    const h = await mount(<AppUpdateHost transport={t} />);
    expect(hasText(h, 'Some built-in tools are missing.')).toBe(true);
    expect(t.repairTools).not.toHaveBeenCalled();
    await click(buttonByText(h, 'Repair'));
    await settle();
    expect(t.repairTools).toHaveBeenCalledWith(false);
    expect(hasText(h, 'Repairing. Potato Workspace will close.')).toBe(true);
  });

  it('names the working agent first, and the second press repairs anyway', async () => {
    const t = transport({
      check: vi.fn(async () => null),
      toolsStatus: vi.fn(async () => MISSING),
      repairTools: vi.fn(async (confirm: boolean) => {
        if (!confirm) throw new Error('UPDATE_RUNNING: claude is working or waiting for you. Confirm to restart anyway; its work is saved first.');
      }),
    });
    const h = await mount(<AppUpdateHost transport={t} />);
    await click(buttonByText(h, 'Repair'));
    await settle();
    expect(hasText(h, 'claude is working or waiting for you.')).toBe(true);
    await click(buttonByText(h, 'Repair and restart anyway'));
    await settle();
    expect(t.repairTools).toHaveBeenLastCalledWith(true);
  });

  it('a failed repair says so plainly and the app goes on', async () => {
    const t = transport({
      check: vi.fn(async () => null),
      toolsStatus: vi.fn(async () => MISSING),
      repairTools: vi.fn(async () => Promise.reject(new Error('Could not reach the update server. Check your internet and try again. Your current version keeps working.'))),
    });
    const h = await mount(<AppUpdateHost transport={t} />);
    await click(buttonByText(h, 'Repair'));
    await settle();
    expect(hasText(h, 'Could not reach the update server.')).toBe(true);
    expect(buttonByText(h, 'Repair')).toBeTruthy();
  });
});

describe('Settings > About', () => {
  it('always has a Repair button for the built-in tools, and says they are in place', async () => {
    const t = transport();
    const h = await mount(<UpdateRow transport={t} versionLine="1.2.0" />);
    expect(buttonByText(h, 'Repair built-in tools')).toBeTruthy();
    expect(hasText(h, 'In place.')).toBe(true);
    await click(buttonByText(h, 'Repair built-in tools'));
    await settle();
    expect(t.repairTools).toHaveBeenCalledWith(false);
  });

  it('says the tools are missing when they are', async () => {
    const h = await mount(<UpdateRow transport={transport({ toolsStatus: vi.fn(async () => MISSING) })} versionLine="1.2.0" />);
    expect(hasText(h, 'Some built-in tools are missing.')).toBe(true);
  });
});
