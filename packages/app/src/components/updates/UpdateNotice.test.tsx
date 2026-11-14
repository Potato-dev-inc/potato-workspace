// @vitest-environment jsdom
// The update notice and the Settings row at screen level: quiet when there is nothing, one button, nothing installs before
// the press, a working agent is warned about first, and a failed update says why in plain words.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UpdateOffer, UpdateTransport } from '../../lib/app-update';
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

const OFFER: UpdateOffer = { currentVersion: '1.0.2', version: '1.0.3', notes: null };

function transport(over: Partial<UpdateTransport> = {}) {
  const t = {
    check: vi.fn(async () => OFFER as UpdateOffer | null),
    busy: vi.fn(async () => [] as string[]),
    install: vi.fn(async (_confirm: boolean) => undefined),
    ...over,
  };
  return t as UpdateTransport & { check: ReturnType<typeof vi.fn>; busy: ReturnType<typeof vi.fn>; install: ReturnType<typeof vi.fn> };
}

async function mount(node: React.ReactElement) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(node));
  await settle(6);
  return host;
}

describe('the notice', () => {
  it('is quiet when this is the newest version', async () => {
    const h = await mount(<AppUpdateHost transport={transport({ check: vi.fn(async () => null) })} />);
    expect(h.querySelector('.app-update-notice')).toBeNull();
  });

  it('is quiet when the quiet check cannot reach the network', async () => {
    const h = await mount(<AppUpdateHost transport={transport({ check: vi.fn(async () => Promise.reject(new Error('Could not reach the update server.'))) })} />);
    expect(h.querySelector('.app-update-notice')).toBeNull();
  });

  it('says Update available with the version, and installs nothing until the button is pressed', async () => {
    const t = transport();
    const h = await mount(<AppUpdateHost transport={t} />);
    expect(hasText(h, 'Update available: 1.0.3')).toBe(true);
    expect(t.install).not.toHaveBeenCalled();
    await click(buttonByText(h, 'Update'));
    await settle();
    expect(t.install).toHaveBeenCalledWith(false);
    expect(hasText(h, 'Installing the update.')).toBe(true);
    expect(hasText(h, 'Open it again when the installer is done')).toBe(true);
  });

  it('downloads first; with agents working it says so, never stops them, and offers When they finish, Tonight and Now', async () => {
    const t = transport({
      install: vi.fn(async (confirm: boolean) => {
        if (!confirm) throw new Error('UPDATE_RUNNING: claude is working or waiting for you.');
      }),
      busyInfo: vi.fn(async () => ({ agents: ['claude', 'codex'], chats: ['claude'], terminals: ['codex'] })),
    });
    const h = await mount(<AppUpdateHost transport={t} />);
    await click(buttonByText(h, 'Update'));
    await settle();
    expect(t.install).toHaveBeenCalledTimes(1);
    expect(t.install).toHaveBeenLastCalledWith(false);
    expect(hasText(h, 'Update ready · 1.0.3.')).toBe(true);
    expect(hasText(h, '2 agents are working.')).toBe(true);
    expect(hasText(h, 'They will not be stopped.')).toBe(true);
    expect(buttonByText(h, 'When they finish')).toBeTruthy();
    expect(buttonByText(h, 'Tonight')).toBeTruthy();
    // When they finish is the default: it is already chosen and waits for the agents.
    expect(buttonByText(h, 'When they finish')!.getAttribute('aria-pressed')).toBe('true');
    expect(hasText(h, 'It installs by itself when they finish.')).toBe(true);
    // The warning about what stops (and what comes back) is on Now.
    const now = buttonByText(h, 'Now')!;
    expect(now.title).toContain('come back after the restart: claude');
    expect(now.title).toContain('not reopened: codex');
    await click(now);
    await settle();
    expect(t.install).toHaveBeenLastCalledWith(true);
  });

  it('shows the download percent while the file comes in', async () => {
    let send: (p: { downloaded: number; total: number | null }) => void = () => undefined;
    let finish: () => void = () => undefined;
    const t = transport({
      onProgress: vi.fn(async (cb) => {
        send = cb;
        return () => undefined;
      }),
      install: vi.fn(() => new Promise<void>((resolve) => (finish = resolve))),
    });
    const h = await mount(<AppUpdateHost transport={t} />);
    await click(buttonByText(h, 'Update'));
    await settle();
    expect(hasText(h, 'Downloading…')).toBe(true);
    await act(async () => send({ downloaded: 42, total: 100 }));
    expect(hasText(h, 'Downloading 42%')).toBe(true);
    expect((h.querySelector('progress') as HTMLProgressElement).value).toBe(42);
    await act(async () => finish());
    await settle();
    expect(hasText(h, 'Installing the update.')).toBe(true);
  });

  it('shows MB of MB, speed and time left, then "Installing…" once everything is in', async () => {
    const MB = 1024 * 1024;
    let send: (p: { downloaded: number; total: number | null }) => void = () => undefined;
    const t = transport({
      onProgress: vi.fn(async (cb) => {
        send = cb;
        return () => undefined;
      }),
      install: vi.fn(() => new Promise<void>(() => undefined)),
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const h = await mount(<AppUpdateHost transport={t} />);
      await click(buttonByText(h, 'Update'));
      await settle();
      await act(async () => send({ downloaded: 10 * MB, total: 138 * MB }));
      expect(hasText(h, '10.0 MB of 138 MB')).toBe(true); // no speed yet: one reading
      vi.setSystemTime(Date.now() + 2000);
      await act(async () => send({ downloaded: 16 * MB, total: 138 * MB }));
      const detail = h.querySelector('[data-testid="update-detail"]')?.textContent ?? '';
      expect(detail).toContain('16.0 MB of 138 MB');
      expect(detail).toContain('3.0 MB/s');
      expect(detail).toMatch(/about \d+ (seconds|minutes) left/);
      await act(async () => send({ downloaded: 138 * MB, total: 138 * MB }));
      expect(hasText(h, 'Installing…')).toBe(true);
      expect(h.querySelector('progress')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('says so when the download stops moving', async () => {
    let send: (p: { downloaded: number; total: number | null }) => void = () => undefined;
    const t = transport({
      onProgress: vi.fn(async (cb) => {
        send = cb;
        return () => undefined;
      }),
      install: vi.fn(() => new Promise<void>(() => undefined)),
    });
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    try {
      const h = await mount(<AppUpdateHost transport={t} />);
      await click(buttonByText(h, 'Update'));
      await settle();
      await act(async () => send({ downloaded: 1000, total: 100000 }));
      expect(hasText(h, 'slow or has stopped')).toBe(false);
      await act(async () => vi.advanceTimersByTime(18_000));
      expect(hasText(h, 'slow or has stopped')).toBe(true);
      await act(async () => send({ downloaded: 2000, total: 100000 }));
      expect(hasText(h, 'slow or has stopped')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('with nothing busy there is no ready step: it goes straight on', async () => {
    const t = transport();
    const h = await mount(<AppUpdateHost transport={t} />);
    await click(buttonByText(h, 'Update'));
    await settle();
    expect(hasText(h, 'Ready.')).toBe(false);
    expect(t.install).toHaveBeenCalledTimes(1);
  });

  it('When they finish installs by itself once nobody is working, and never before', async () => {
    vi.useFakeTimers();
    try {
      let busyNow = ['claude'];
      const t = transport({
        install: vi.fn(async (confirm: boolean) => {
          if (!confirm && busyNow.length > 0) throw new Error('UPDATE_RUNNING: claude is working.');
        }),
        busyInfo: vi.fn(async () => ({ agents: busyNow, chats: busyNow, terminals: [] })),
      });
      const h = await mount(<AppUpdateHost transport={t} />);
      await click(buttonByText(h, 'Update'));
      await settle();
      expect(t.install).toHaveBeenCalledTimes(1);
      // Still working: ten minutes of waiting installs nothing and stops nothing.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10 * 60_000);
      });
      expect(t.install).toHaveBeenCalledTimes(1);
      expect(t.install).not.toHaveBeenCalledWith(true);
      busyNow = [];
      await act(async () => {
        await vi.advanceTimersByTimeAsync(11_000);
      });
      expect(t.install).toHaveBeenCalledTimes(2);
      expect(t.install).toHaveBeenLastCalledWith(false);
      expect(hasText(h, 'Installing the update.')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Tonight waits for 02:00 (no quiet hours set) and for the agents, then installs', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
    try {
      vi.setSystemTime(new Date(2026, 10, 14, 22, 0, 0));
      let busyNow = ['claude'];
      const t = transport({
        install: vi.fn(async (confirm: boolean) => {
          if (!confirm && busyNow.length > 0) throw new Error('UPDATE_RUNNING: claude is working.');
        }),
        busyInfo: vi.fn(async () => ({ agents: busyNow, chats: busyNow, terminals: [] })),
      });
      const h = await mount(<AppUpdateHost transport={t} />);
      await click(buttonByText(h, 'Update'));
      await settle();
      await click(buttonByText(h, 'Tonight'));
      expect(buttonByText(h, 'Tonight')!.getAttribute('aria-pressed')).toBe('true');
      expect(hasText(h, 'It installs at')).toBe(true);
      // Nobody is working at 23:00, but it is not night yet: nothing installs.
      busyNow = [];
      vi.setSystemTime(new Date(2026, 10, 14, 23, 0, 0));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(11_000);
      });
      expect(t.install).toHaveBeenCalledTimes(1);
      // 02:05 next day, an agent is working again: still nothing.
      busyNow = ['claude'];
      vi.setSystemTime(new Date(2026, 10, 15, 2, 5, 0));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(11_000);
      });
      expect(t.install).toHaveBeenCalledTimes(1);
      // The agent finished: now it installs.
      busyNow = [];
      await act(async () => {
        await vi.advanceTimersByTimeAsync(11_000);
      });
      expect(t.install).toHaveBeenCalledTimes(2);
      expect(t.install).toHaveBeenLastCalledWith(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('remembers what is new before the restart, and shows it once after (three lines, chats back)', async () => {
    window.localStorage.clear();
    const t = transport({
      check: vi.fn(async () => ({ currentVersion: '1.0.2', version: '1.0.3', notes: '- First thing\n- Second thing\n- Third thing\n- Fourth thing' })),
      busyInfo: vi.fn(async () => ({ agents: [], chats: [], terminals: [] })),
    });
    const h = await mount(<AppUpdateHost transport={t} />);
    await click(buttonByText(h, 'Update'));
    await settle();
    expect(window.localStorage.getItem('pm.update.whatsNew')).toContain('1.0.3');
    // After the restart the running version is the new one.
    await act(async () => root!.unmount());
    host!.remove();
    const after = transport({ check: vi.fn(async () => null), currentVersion: vi.fn(async () => '1.0.3') });
    const h2 = await mount(<AppUpdateHost transport={after} />);
    await settle();
    const card = h2.querySelector('[data-testid="whats-new-card"]')!;
    expect(card.textContent).toContain('What is new in 1.0.3');
    expect(card.querySelectorAll('li').length).toBe(3);
    expect(card.textContent).not.toContain('Fourth thing');
    // Shown once: it is gone from storage, so another start shows nothing.
    expect(window.localStorage.getItem('pm.update.whatsNew')).toBeNull();
    await click(buttonByText(h2, 'Got it'));
    expect(h2.querySelector('[data-testid="whats-new-card"]')).toBeNull();
  });

  it('shows no What is new card when the running version is not the one that was installed', async () => {
    window.localStorage.setItem('pm.update.whatsNew', JSON.stringify({ version: '1.0.9', notes: 'x', chats: 0 }));
    const h = await mount(<AppUpdateHost transport={transport({ check: vi.fn(async () => null), currentVersion: vi.fn(async () => '1.0.3') })} />);
    await settle();
    expect(h.querySelector('[data-testid="whats-new-card"]')).toBeNull();
    window.localStorage.clear();
  });

  it('says the agents were stopped when the installer could not start, and Reopen chats brings them back', async () => {
    const t = transport({
      install: vi.fn(async () => Promise.reject(new Error('UPDATE_STOPPED: Agents were stopped. The update could not be installed. Your current version keeps working.'))),
      reopenChats: vi.fn(async () => undefined),
    });
    const h = await mount(<AppUpdateHost transport={t} />);
    await click(buttonByText(h, 'Update'));
    await settle();
    expect(hasText(h, 'Agents were stopped.')).toBe(true);
    expect(hasText(h, 'UPDATE_STOPPED')).toBe(false);
    await click(buttonByText(h, 'Reopen chats'));
    await settle();
    expect(t.reopenChats).toHaveBeenCalledTimes(1);
    expect(hasText(h, 'Chats reopened. Terminal agents were not reopened.')).toBe(true);
  });

  it('a bad signature is refused with a plain sentence and the app carries on', async () => {
    const t = transport({
      install: vi.fn(async () => Promise.reject(new Error('The update did not pass its safety check, so it was not installed. Your current version keeps working.'))),
    });
    const h = await mount(<AppUpdateHost transport={t} />);
    await click(buttonByText(h, 'Update'));
    await settle();
    expect(hasText(h, 'did not pass its safety check')).toBe(true);
    expect(buttonByText(h, 'Try again')).toBeDefined();
  });

  it('a network failure during the install says so in plain words', async () => {
    const t = transport({ install: vi.fn(async () => Promise.reject(new Error('NETWORK: Could not reach the update server. Check your internet and try again. Your current version keeps working.'))) });
    const h = await mount(<AppUpdateHost transport={t} />);
    await click(buttonByText(h, 'Update'));
    await settle();
    expect(hasText(h, 'Could not reach the update server')).toBe(true);
    expect(hasText(h, 'NETWORK')).toBe(false);
  });
});

describe('the Settings row', () => {
  it('does not check until Check for updates is pressed, and says when there is nothing new', async () => {
    const t = transport({ check: vi.fn(async () => null) });
    const h = await mount(<UpdateRow transport={t} />);
    expect(t.check).not.toHaveBeenCalled();
    await click(buttonByText(h, 'Check for updates'));
    await settle();
    expect(t.check).toHaveBeenCalledTimes(1);
    expect(hasText(h, 'You have the newest version.')).toBe(true);
  });

  it('shows the offer and the plain error of a failed check', async () => {
    const h = await mount(<UpdateRow transport={transport()} />);
    await click(buttonByText(h, 'Check for updates'));
    await settle();
    expect(hasText(h, 'Update available: 1.0.3')).toBe(true);
    await act(async () => root!.unmount());
    root = undefined;
    host?.remove();
    const h2 = await mount(<UpdateRow transport={transport({ check: vi.fn(async () => Promise.reject(new Error('No update information was found right now. Try again later.'))) })} />);
    await click(buttonByText(h2, 'Check for updates'));
    await settle();
    expect(hasText(h2, 'No update information was found')).toBe(true);
  });
});

describe('a channel that cannot be read', () => {
  const BETA_FAILED = 'CHECK_FAILED_BETA: Couldn\'t check for early versions. Try again later.';
  const STABLE_FAILED = 'CHECK_FAILED_STABLE: Couldn\'t check for updates. Try again later.';

  it('shows the early-versions line for a failed beta check and never says up to date', async () => {
    const h = await mount(<UpdateRow transport={transport({ check: vi.fn(async () => Promise.reject(BETA_FAILED)) })} />);
    await click(buttonByText(h, 'Check for updates'));
    await settle();
    expect(hasText(h, 'Couldn\'t check for early versions. Try again later.')).toBe(true);
    expect(hasText(h, 'You have the newest version.')).toBe(false);
    expect(h.textContent).not.toMatch(/up to date/i);
  });

  it('shows its own line when the stable address cannot be read', async () => {
    const h = await mount(<UpdateRow transport={transport({ check: vi.fn(async () => Promise.reject(STABLE_FAILED)) })} />);
    await click(buttonByText(h, 'Check for updates'));
    await settle();
    expect(hasText(h, 'Couldn\'t check for updates. Try again later.')).toBe(true);
    expect(h.textContent).not.toMatch(/up to date|newest version/i);
  });

  it('a quiet check that fails shows nothing in the corner', async () => {
    const h = await mount(<AppUpdateHost transport={transport({ check: vi.fn(async () => Promise.reject(BETA_FAILED)) })} />);
    expect(h.querySelector('.app-update-notice')).toBeNull();
  });
});
