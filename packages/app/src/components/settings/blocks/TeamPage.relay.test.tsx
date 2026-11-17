// @vitest-environment jsdom
// Start a team with ONE relay: a relay already on this PC (the phone's Worker) is the recommended way and needs no
// Cloudflare token; with none, the recommended way is the one guided setup, and the token way sits under Other ways.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { teamConfig } from '../../../dev/team-fixtures';
import { setLanguagePref } from '../../../i18n';
import type { TeamApi, TeamConfigView } from '../../../lib/team';
import type { TunnelStatus } from '../../../lib/tauri-types';
import type { WorkerHealth } from '../../../lib/worker';
import type { TunnelApi } from '../TunnelSection';
import { buttonByText, click, hasText, settle, type as typeInto } from '../test-utils';
import { TeamPage } from './TeamPage';

vi.mock('qrcode', () => ({ default: { toCanvas: vi.fn(async () => undefined) } }));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  setLanguagePref('en', false);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = '';
  setLanguagePref('en', false);
});

const WORKER = 'https://pm-relay.maya.workers.dev';
const NOT_ON_TEAM: Partial<TeamConfigView> = { enabled: false, team: '', teamName: '', relay: '', name: '', members: [], joins: [], admin: false, transport: null, link: null };
const OK: WorkerHealth = { reachable: true, features: ['team', 'rooms', 'stable-link', 'invites'], legacyLink: false };

const stableStatus = (url: string): TunnelStatus =>
  ({ mode: 'stable', public_url: null, state: 'running', error: null, config: { mode: 'stable', hostname: null, url, has_token: false, has_secret: true }, stable: { worker_url: url, quick_url: null, link: 'linked', error: null } }) as TunnelStatus;

function fakeApi() {
  const calls: string[] = [];
  const api = {
    calls,
    configGet: async () => teamConfig(NOT_ON_TEAM),
    defaultName: async () => 'Pat',
    create: async (input: unknown) => {
      calls.push(`create(${JSON.stringify(input)})`);
      return teamConfig({ joins: [], members: teamConfig().members.slice(0, 1) });
    },
    invite: async () => ({ link: 'pm://team/join?t=Acme&k=abc123', code: 'KQ7M-4XPD', expiresAtMs: Date.now() + 600_000 }),
    deployRelay: async () => {
      calls.push('deployRelay');
      return { status: 'done', url: WORKER };
    },
    onRelayDeployStep: async () => () => {},
    onChanged: async () => () => {},
  };
  return api as typeof api & TeamApi;
}

function fakeTunnel(status: TunnelStatus | null): TunnelApi & { saved: unknown[] } {
  const saved: unknown[] = [];
  return {
    saved,
    getStatus: async () => status,
    save: async (input) => {
      saved.push(input);
      return stableStatus(WORKER);
    },
    restart: async () => stableStatus(WORKER),
    test: async () => ({ ok: true, url: WORKER, http_status: 200, latency_ms: 5, message: 'ok' }),
  };
}

async function openStart(opts: { relay: string | null; health?: WorkerHealth | null; tunnel?: TunnelApi }) {
  const api = fakeApi();
  const tunnel: TunnelApi & { saved?: unknown[] } = opts.tunnel ?? fakeTunnel(null);
  await act(async () =>
    root.render(
      <TeamPage
        api={api}
        onSaved={vi.fn()}
        workers={{ savedLink: async () => opts.relay, check: async () => (opts.health === undefined ? OK : opts.health), tunnel }}
      />,
    ),
  );
  await settle(5);
  // The first big choice is "Start a team".
  await click(host.querySelector('button'));
  await settle(5);
  return { api, tunnel };
}
const field = (label: string) =>
  [...host.querySelectorAll('label')].find((l) => l.querySelector('span')?.textContent === label)?.querySelector('input') as HTMLInputElement;
const buttons = () => [...host.querySelectorAll('button')].map((b) => b.textContent?.trim());
const otherWays = () => [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Other ways'));

describe('Start a team with one relay', () => {
  it('a relay exists: "Use my relay" is the recommended card, there is no token step, and Create makes the team on that Worker', async () => {
    const { api } = await openStart({ relay: WORKER });
    expect(host.querySelector('[data-testid="relay-use"]')).not.toBeNull();
    expect(hasText(host, 'Use my relay (pm-relay.maya.workers.dev)')).toBe(true);
    expect(hasText(host, 'Recommended')).toBe(true);
    expect(hasText(host, 'No Cloudflare token needed')).toBe(true);
    expect(buttons()).not.toContain('Set up my relay');
    expect(buttons()).not.toContain('Create team relay'); // the token way is folded away
    const create = host.querySelector<HTMLButtonElement>('[data-testid="relay-use"] > button')!;
    expect(create.disabled).toBe(true); // no team name yet
    await typeInto(field('Team name'), 'Acme');
    expect(create.disabled).toBe(false);
    await click(create);
    await settle(5);
    expect(api.calls).not.toContain('deployRelay');
    expect(api.calls.find((c) => c.startsWith('create'))).toBe(`create({"teamName":"Acme","name":"Pat","relay":"${WORKER}","folder":""})`);
  });

  it('a relay exists: the token way is still there under Other ways', async () => {
    await openStart({ relay: WORKER });
    await click(otherWays());
    expect(host.querySelector('[data-testid="relay-token-way"]')).not.toBeNull();
    expect(hasText(host, 'Create a relay with a Cloudflare token')).toBe(true);
  });

  it('a relay exists but is an older deploy: says "Update your Worker" and holds Create', async () => {
    await openStart({ relay: WORKER, health: { reachable: true, features: ['stable-link'], legacyLink: true } });
    expect(host.querySelector('[data-testid="worker-update"]')).not.toBeNull();
    await typeInto(field('Team name'), 'Acme');
    expect(host.querySelector<HTMLButtonElement>('[data-testid="relay-use"] > button')!.disabled).toBe(true);
  });

  it('a relay exists but does not answer: says so and holds Create', async () => {
    await openStart({ relay: WORKER, health: { reachable: false, features: [], legacyLink: false } });
    expect(hasText(host, 'did not answer')).toBe(true);
    await typeInto(field('Team name'), 'Acme');
    expect(buttonByText(host.querySelector('[data-testid="relay-use"]')!, 'Create team')!.disabled).toBe(true);
  });

  it('no relay yet: "Set up my relay" is recommended and runs the one guided setup; the token way is under Other ways', async () => {
    const { tunnel } = await openStart({ relay: null });
    expect(host.querySelector('[data-testid="relay-setup"]')).not.toBeNull();
    expect(hasText(host, 'Recommended')).toBe(true);
    expect(hasText(host, 'you only do this once')).toBe(true);
    expect(buttons()).not.toContain('Create team relay');
    await click(buttonByText(host, 'Set up my relay'));
    await settle(5);
    // The same guided sheet as the phone's "Keep one address".
    expect(document.querySelector('[data-testid="stable-sheet"]')).not.toBeNull();
    expect(tunnel.saved).toEqual([]);
    await click(otherWays());
    expect(buttons()).toContain('Create team relay');
  });

  it('no relay yet: once the guided setup saves a Worker, the card turns into "Use my relay"', async () => {
    const tunnel = fakeTunnel(null);
    await openStart({ relay: null, tunnel });
    await click(buttonByText(host, 'Set up my relay'));
    await settle(5);
    const sheet = document.querySelector('[data-testid="stable-sheet"]')!;
    await typeInto(sheet.querySelector<HTMLInputElement>('input')!, WORKER);
    const labels = [...sheet.querySelectorAll('button')].map((b) => `${b.textContent}:${b.disabled}`);
    const save = [...sheet.querySelectorAll<HTMLButtonElement>('button')].find((b) => !b.disabled && /save|use|link|keep/i.test(b.textContent ?? ''));
    expect(save, labels.join(' | ')).toBeDefined();
    await click(save);
    await settle(8);
    expect(tunnel.saved.length).toBeGreaterThan(0);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await settle(5);
    expect(host.querySelector('[data-testid="relay-use"]')).not.toBeNull();
    expect(hasText(host, 'Use my relay (pm-relay.maya.workers.dev)')).toBe(true);
  });

  it('the guided sheet stays open (secret step and all) after it saves the Worker; the card flips only when it is closed', async () => {
    const tunnel = fakeTunnel(null);
    await openStart({ relay: null, tunnel });
    await click(buttonByText(host, 'Set up my relay'));
    await settle(5);
    const sheet = () => document.querySelector('[data-testid="stable-sheet"]');
    await typeInto(sheet()!.querySelector<HTMLInputElement>('input')!, WORKER);
    const save = [...sheet()!.querySelectorAll<HTMLButtonElement>('button')].find((b) => !b.disabled && /save|use|link|keep/i.test(b.textContent ?? ''));
    await click(save);
    await settle(8);
    expect(tunnel.saved.length).toBeGreaterThan(0);
    expect(sheet()).not.toBeNull(); // still open: nothing was unmounted mid-setup
    expect(host.querySelector('[data-testid="relay-use"]')).toBeNull();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await settle(5);
    expect(sheet()).toBeNull();
    expect(hasText(host, 'Use my relay (pm-relay.maya.workers.dev)')).toBe(true);
  });

  it('an unreachable relay offers Try again, which asks again', async () => {
    let calls = 0;
    const api = fakeApi();
    await act(async () =>
      root.render(<TeamPage api={api} onSaved={vi.fn()} workers={{ savedLink: async () => WORKER, check: async () => (++calls === 1 ? { reachable: false, features: [], legacyLink: false } : OK), tunnel: fakeTunnel(null) }} />),
    );
    await settle(5);
    await click(host.querySelector('button'));
    await settle(5);
    expect(hasText(host, 'did not answer')).toBe(true);
    await click(buttonByText(host, 'Try again'));
    await settle(5);
    expect(hasText(host, 'did not answer')).toBe(false);
    expect(calls).toBe(2);
  });

  it('speaks Traditional Chinese, both states', async () => {
    setLanguagePref('zh-TW', false);
    await openStart({ relay: WORKER });
    expect(hasText(host, '使用我的中繼站（pm-relay.maya.workers.dev）')).toBe(true);
    expect(hasText(host, '不需要 Cloudflare 權杖')).toBe(true);
    expect(hasText(host, 'Use my relay')).toBe(false);
    await act(async () => root.unmount());
    root = createRoot(host);
    await openStart({ relay: null });
    expect(hasText(host, '設定我的中繼站')).toBe(true);
    expect(hasText(host, 'Set up my relay')).toBe(false);
  });
});
