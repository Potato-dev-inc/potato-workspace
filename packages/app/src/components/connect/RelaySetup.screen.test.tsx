// @vitest-environment jsdom
// "Set up my relay": the ONE button. Three places open the same flow; the happy path runs with the fake step commands
// (nothing here touches Cloudflare): the address comes from the deploy output (no paste step), the key is made and kept
// by the app and is hidden until asked for. Each plain-words problem has one fix button. Rendered through the real
// Connect page (the relay card above the tabs) and the real Start-a-team relay card.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '@potato-workspace/shared';
import { DevicesFake } from '../../dev/devices-fixtures';
import { createFakeLendApi, lendState } from '../../dev/lend-fixtures';
import { teamConfig, teamState } from '../../dev/team-fixtures';
import { relayAddress } from '../../lib/relaySetup';
import { en } from '../../i18n/en';
import { zhTW } from '../../i18n/zh-TW';
import { setLanguagePref } from '../../i18n';
import type { TunnelStatus } from '../../lib/tauri-types';
import type { TeamApi } from '../../lib/team';
import type { UpdateApi, StepAnswer } from '../../lib/workerUpdate';
import type { TunnelApi } from '../settings/TunnelSection';
import { RelayChoice } from '../settings/blocks/RelayChoice';
import { BASE_SETTINGS, click, settle, type } from '../settings/test-utils';
import { resetRememberedTab } from '../team-page/TeamPage';
import { fakeAccount } from './connect-test-utils';
import { ConnectPage, type ConnectApi } from './ConnectPage';
import type { ConnectTab } from '../../lib/openConnect';

vi.mock('qrcode', () => ({ default: { toCanvas: vi.fn(async () => undefined) } }));
vi.mock('../settings/TunnelSection', () => ({ TunnelSection: () => <div data-testid="tunnel-stub" /> }));
vi.mock('../../lib/load-tunnel-dev-info', () => ({ watchTunnelDevInfo: vi.fn(() => () => undefined) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView = () => {};

const WORKER = 'https://pm-relay.maya.workers.dev';
const KEY = 'KEY-0123456789-ABCDEFGHIJ';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  setLanguagePref('en', false);
  resetRememberedTab();
  window.localStorage.clear();
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

const quick: TunnelStatus = {
  mode: 'quick',
  public_url: null,
  state: 'running',
  error: null,
  config: { mode: 'quick', hostname: null, url: null, has_token: false },
} as TunnelStatus;
const stable = (link: 'linked' | 'waiting' | 'failed', extra: Partial<NonNullable<TunnelStatus['stable']>> = {}): TunnelStatus =>
  ({
    mode: 'stable',
    public_url: null,
    state: 'running',
    error: null,
    config: { mode: 'stable', hostname: null, url: WORKER, has_token: false, has_secret: true },
    stable: { worker_url: WORKER, quick_url: null, link, error: null, ...extra },
  }) as TunnelStatus;

/** A tunnel fake that remembers what was saved: after a save it answers with `after`. */
function fakeTunnel(after: TunnelStatus | (() => TunnelStatus), secretOnce: string | null = KEY) {
  const saved: unknown[] = [];
  let current: TunnelStatus = quick;
  const api: TunnelApi = {
    getStatus: async () => current,
    save: async (input) => {
      saved.push(input);
      current = typeof after === 'function' ? after() : after;
      return { ...current, secret_once: secretOnce };
    },
    restart: async () => current,
    test: async () => ({ ok: true, url: WORKER, http_status: 200, latency_ms: 1, message: 'ok' }),
  };
  return { api, saved };
}

type Script = Partial<Record<string, StepAnswer | StepAnswer[]>>;
/** A fake step runner: each step answers from `script` (a list is used one answer per run), otherwise it works. */
function fakeSteps(script: Script = {}) {
  const calls: string[] = [];
  const names: (string | undefined)[] = [];
  const counts: Record<string, number> = {};
  const updateApi: UpdateApi = {
    step: async (id, address, confirmed, name) => {
      calls.push(`${id}@${address ?? 'new'}${confirmed ? '!' : ''}`);
      names.push(name);
      const s = script[id];
      const n = (counts[id] = (counts[id] ?? 0) + 1);
      if (Array.isArray(s)) return s[Math.min(n - 1, s.length - 1)]!;
      return s ?? { ok: true, output: `${id} ok`, url: id === 'deploy' ? WORKER : undefined };
    },
    check: async () => ({ reachable: true, features: ['team', 'stable-link'], legacyLink: false }),
    pauseMs: 0,
  };
  return { updateApi, calls, names };
}

function connectApi(tunnel: TunnelApi, updateApi: UpdateApi): Partial<ConnectApi> {
  const team = {
    state: async () => teamState({ active: false, presence: [] }),
    configGet: async () => teamConfig({ team: '', relay: '' }),
    defaultName: async () => 'Leo',
    onChanged: async () => () => {},
    onDraft: async () => () => {},
  } as unknown as TeamApi;
  const settings = { ...BASE_SETTINGS, lend_enabled: true, devices_enabled: true } as Settings;
  return {
    loadSettings: async () => settings,
    patchSettings: async () => settings,
    listPhones: async () => [],
    devices: new DevicesFake({ enabled: true }),
    team,
    lend: createFakeLendApi(lendState({ grants: [] })),
    tunnel,
    updateApi,
    account: fakeAccount(null),
  };
}

async function mount(a: Partial<ConnectApi>, tab: ConnectTab = 'devices') {
  await act(async () => root.render(<ConnectPage tab={tab} onTab={() => undefined} api={a} />));
  await settle(8);
}
const q = (sel: string) => document.querySelector(sel);
const text = (sel: string) => q(sel)?.textContent ?? '';

/** Opens the flow from the relay card above the tabs and waits for the fakes to finish. */
async function runFromCard(tunnel: TunnelApi, updateApi: UpdateApi) {
  await mount(connectApi(tunnel, updateApi));
  await click(q('[data-testid="relay-set-up"]'));
  await settle(30);
}

describe('Set up my relay: three places, one flow', () => {
  it('Devices > This PC: the one button, and the plain note under it', async () => {
    await mount(connectApi(fakeTunnel(stable('linked')).api, fakeSteps().updateApi));
    const card = q('[data-testid="relay-set-up"]')!;
    expect(card).not.toBeNull();
    expect(q('[data-testid="connect-relay-none"]')).toBeNull();
    expect(text('[data-testid="relay-set-up"]')).toBe('Make it work anywhere');
    expect(text('[data-testid="connect-relay"]')).toContain('Free. About 2 minutes.');
    await click(q('[data-testid="relay-set-up"]'));
    await settle(4);
    expect(q('[data-testid="relay-sheet"]')).not.toBeNull();
    expect(q('[data-testid="stable-sheet"]')).toBeNull();
  });


  it('Start a team with no relay: the recommended button opens the same sheet; the step-by-step sheet is one quiet press away', async () => {
    const t = fakeTunnel(stable('linked'));
    await act(async () =>
      root.render(<RelayChoice address={null} disabled={false} onUse={vi.fn()} onSaved={vi.fn()} updateApi={fakeSteps().updateApi} tunnelApi={t.api} />),
    );
    await settle(3);
    expect(host.textContent).toContain('Free. About 2 minutes. You only do it once.');
    await click(q('[data-testid="relay-set-up"]'));
    await settle(4);
    expect(q('[data-testid="relay-sheet"]')).not.toBeNull();
    expect(q('[data-testid="stable-sheet"]')).toBeNull();
  });
});

describe('Set up my relay: the happy path (fake step commands)', () => {
  it('runs every step, reads the address from the deploy, makes the key itself, and ends on the done screen', async () => {
    const t = fakeTunnel(stable('linked'));
    const s = fakeSteps();
    await runFromCard(t.api, s.updateApi);

    expect(s.calls).toEqual(['prepare@new', 'install@new', 'login@new', 'look@new', 'deploy@new']);
    // No "paste your address" step and no field anywhere in the sheet.
    expect(q('[data-testid="relay-sheet"] input')).toBeNull();
    expect(text('[data-testid="relay-sheet"]')).not.toMatch(/paste/i);
    // The app linked this PC with the address it read itself, and let the backend make the key (no secret given).
    expect(t.saved).toEqual([{ mode: 'stable', worker_url: WORKER, secret: null, secret_action: 'keep' }]);
    expect(text('[data-testid="relay-sheet"]')).toContain('Done. Your phone and your team can now reach this PC from anywhere.');
    expect(text('[data-testid="relay-done-host"]')).toBe('pm-relay.maya.workers.dev');
    expect(text('[data-testid="relay-done-status"]')).toBe('Works anywhere');
    expect([...document.querySelectorAll('[data-testid="relay-steps"] li')].every((li) => li.getAttribute('data-status') === 'done')).toBe(true);
  });

  it('the key is hidden by default, shown once with the eye, and never rendered anywhere else', async () => {
    const t = fakeTunnel(stable('linked'));
    await runFromCard(t.api, fakeSteps().updateApi);
    expect(document.body.textContent).not.toContain(KEY);
    expect(q('[data-testid="stable-secret"]')).toBeNull();
    await click(q('[data-testid="relay-key-toggle"]'));
    expect(text('[data-testid="relay-sheet"]')).toContain('Save a copy of your key');
    expect(q('[data-testid="stable-secret"]')!.getAttribute('data-hidden')).toBe('true');
    expect(document.body.textContent).not.toContain(KEY);
    await click(q('[data-testid="stable-secret-eye"]'));
    expect(text('[data-testid="stable-secret"]')).toBe(KEY);
  });

  it('never writes the key to the console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    await runFromCard(fakeTunnel(stable('linked')).api, fakeSteps().updateApi);
    await click(q('[data-testid="relay-key-toggle"]'));
    await click(q('[data-testid="stable-secret-eye"]'));
    expect(spies.flatMap((s) => s.mock.calls).some((c) => JSON.stringify(c).includes(KEY))).toBe(false);
  });

  it('waits for the sign-in with plain words and a Cancel that closes the sheet and saves nothing', async () => {
    const t = fakeTunnel(stable('linked'));
    let stop: (a: StepAnswer) => void = () => undefined;
    const pending = new Promise<StepAnswer>((r) => (stop = r));
    const cancels: number[] = [];
    const base = fakeSteps().updateApi;
    const updateApi: UpdateApi = {
      ...base,
      step: (id, a, c) => (id === 'login' ? pending : base.step(id, a, c)),
      // The backend kills the tool it started: the pending step then answers.
      cancel: () => {
        cancels.push(1);
        stop({ ok: false, output: 'Cancelled.' });
      },
    };
    await mount(connectApi(t.api, updateApi));
    await click(q('[data-testid="relay-set-up"]'));
    await settle(8);
    expect(text('[data-testid="relay-wait-login"]')).toBe('Waiting for you to sign in to Cloudflare...');
    expect(q('[data-step="login"]')!.getAttribute('data-status')).toBe('running');
    await click(q('[data-testid="relay-cancel"]'));
    await settle(4);
    expect(q('[data-testid="relay-sheet"]')).toBeNull();
    expect(cancels).toHaveLength(1);
    expect(t.saved).toEqual([]);
    expect(q('[data-testid="relay-set-up"]')).not.toBeNull();
  });

  it('keeps the sheet on the done screen while the saved relay already flips the page behind it, then shows the status row', async () => {
    const t = fakeTunnel(stable('linked'));
    await runFromCard(t.api, fakeSteps().updateApi);
    // The page behind already reads the saved relay (a poll): the sheet is still there.
    await settle(3);
    expect(q('[data-testid="relay-sheet"]')).not.toBeNull();
    await click(q('[data-testid="relay-close"]'));
    await settle(8);
    expect(q('[data-testid="relay-sheet"]')).toBeNull();
    expect(q('[data-testid="relay-set-up"]')).toBeNull();
    expect(text('[data-testid="connect-relay-host"]')).toBe('pm-relay.maya.workers.dev');
    expect(text('[data-testid="connect-relay-status"]')).toBe('Works anywhere');
  });

  it('a failure offers Copy report (scrubbed), never a fold', async () => {
    const long = 'A'.repeat(40);
    const writes: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (s: string) => (writes.push(s), undefined) }, configurable: true });
    const s = fakeSteps({ install: { ok: false, output: `installed ${long}` } });
    await runFromCard(fakeTunnel(stable('linked')).api, s.updateApi);
    expect(q('details')).toBeNull();
    expect(q('[data-testid="relay-details-toggle"]')).toBeNull();
    await click(q('[data-testid="relay-copy-report"]'));
    await settle(4);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('installed');
    expect(writes[0]).not.toContain(long);
    expect(text('[data-testid="relay-copy-report"]')).toBe('Copied');
  });
});

describe('Set up my relay: each problem in plain words, with one fix button', () => {
  const cases: Array<{ name: string; script: Script; message: RegExp; fix: string; stopsAfter: string }> = [
    {
      name: 'sign-in refused (real message)',
      script: { login: { ok: false, output: 'Consent denied. You must grant consent to Wrangler in order to login.' } },
      message: /Signing in to Cloudflare did not finish/,
      fix: 'Try again',
      stopsAfter: 'login',
    },
    {
      name: 'sign-in timed out (real message)',
      script: { login: { ok: false, output: 'Timed out waiting for authorization code, please try again.' } },
      message: /Signing in to Cloudflare did not finish/,
      fix: 'Try again',
      stopsAfter: 'login',
    },
    {
      name: 'no internet: fetch failed',
      script: { deploy: { ok: false, output: 'TypeError: fetch failed' } },
      message: /Could not reach Cloudflare\. Check your internet/,
      fix: 'Try again',
      stopsAfter: 'deploy',
    },
    {
      name: 'no internet: ENOTFOUND',
      script: { deploy: { ok: false, output: 'getaddrinfo ENOTFOUND api.cloudflare.com' } },
      message: /Could not reach Cloudflare\. Check your internet/,
      fix: 'Try again',
      stopsAfter: 'deploy',
    },
    {
      name: 'no workers.dev name yet (real message)',
      script: { deploy: { ok: false, output: 'You need to register a workers.dev subdomain before publishing to workers.dev' } },
      message: /pick a free name for your account/,
      fix: 'Open Cloudflare',
      stopsAfter: 'deploy',
    },
    {
      name: 'account not verified (real message)',
      script: { deploy: { ok: false, output: "Please verify your account's email address and try again." } },
      message: /confirm your email first/,
      fix: 'Open Cloudflare',
      stopsAfter: 'deploy',
    },
    {
      name: 'several Cloudflare accounts (real message)',
      script: { deploy: { ok: false, output: 'More than one account available but unable to select one in non-interactive mode.' } },
      message: /more than one account/,
      fix: 'Open Cloudflare',
      stopsAfter: 'deploy',
    },
    {
      name: 'tool install failed (real message)',
      script: { install: { ok: false, output: 'npm error code EACCES\nnpm error path C:/x' } },
      message: /could not be installed/,
      fix: 'Try again',
      stopsAfter: 'install',
    },
    {
      name: 'rate limit',
      script: { deploy: { ok: false, output: 'Error 429: too many requests' } },
      message: /asked us to slow down/,
      fix: 'Try again',
      stopsAfter: 'deploy',
    },
    {
      name: 'Cloudflare generic error 10013 is NOT a rate limit',
      script: { deploy: { ok: false, output: 'A request to the Cloudflare API failed. [code: 10013]' } },
      message: /Something did not work/,
      fix: 'Try again',
      stopsAfter: 'deploy',
    },
    {
      name: 'wrangler "does not match" about something else is NOT an old relay',
      script: { deploy: { ok: false, output: 'Request body length does not match content-length header' } },
      message: /Something did not work/,
      fix: 'Try again',
      stopsAfter: 'deploy',
    },
    {
      name: 'container class_name message is NOT an old relay',
      script: { deploy: { ok: false, output: 'The class_name does not match the exported container class' } },
      message: /Something did not work/,
      fix: 'Try again',
      stopsAfter: 'deploy',
    },
    {
      name: 'API token message (generic)',
      script: { deploy: { ok: false, output: "In a non-interactive environment, it's necessary to set a CLOUDFLARE_API_TOKEN environment variable" } },
      message: /Something did not work/,
      fix: 'Try again',
      stopsAfter: 'deploy',
    },
    { name: 'something else', script: { deploy: { ok: false, output: 'boom' } }, message: /Something did not work/, fix: 'Try again', stopsAfter: 'deploy' },
  ];
  for (const c of cases) {
    it(`${c.name}`, async () => {
      const t = fakeTunnel(stable('linked'));
      const s = fakeSteps(c.script);
      await runFromCard(t.api, s.updateApi);
      const problem = q('[data-testid="relay-problem"]');
      expect(problem, document.body.textContent ?? '').not.toBeNull();
      expect(problem!.textContent).toMatch(c.message);
      expect(text('[data-testid="relay-fix"]')).toBe(c.fix);
      expect(q('[data-testid="relay-problem"]')!.getAttribute('data-problem')).not.toBe('mismatch');
      expect(t.saved).toEqual([]);
      expect(q('[data-step="' + c.stopsAfter + '"]')!.getAttribute('data-status')).toBe('failed');
    });
  }

  it('the Open Cloudflare button opens the browser page', async () => {
    const opened: string[] = [];
    const s = fakeSteps({ deploy: { ok: false, output: 'register a workers.dev subdomain' } });
    const { RelaySetupSheet } = await import('./RelaySetup');
    await act(async () =>
      root.render(
        <RelaySetupSheet api={fakeTunnel(stable('linked')).api} updateApi={s.updateApi} openExternal={(u) => void opened.push(u)} onClose={() => undefined} />,
      ),
    );
    await settle(30);
    await click(q('[data-testid="relay-fix"]'));
    expect(opened).toEqual(['https://dash.cloudflare.com/']);
  });

  it('Try again runs the whole thing again and then finishes', async () => {
    const t = fakeTunnel(stable('linked'));
    const s = fakeSteps({
      login: [
        { ok: false, output: 'Login was cancelled' },
        { ok: true, output: 'signed in' },
      ],
    });
    await runFromCard(t.api, s.updateApi);
    expect(q('[data-testid="relay-problem"]')).not.toBeNull();
    await click(q('[data-testid="relay-fix"]'));
    await settle(30);
    expect(q('[data-testid="relay-problem"]')).toBeNull();
    expect(q('[data-testid="relay-sheet"]')!.getAttribute('data-phase')).toBe('done');
    expect(t.saved).toHaveLength(1);
  });

  it('an old relay that holds another key: "Looks like an old relay is in the way" > Start fresh, with its confirm', async () => {
    let n = 0;
    // First link attempt: the relay answers with another key. After the fresh start it links.
    const t = fakeTunnel(() => (++n === 1 ? stable('failed', { secret_mismatch: true, error: 'The secret does not match.' }) : stable('linked')));
    const s = fakeSteps();
    await runFromCard(t.api, s.updateApi);
    expect(q('[data-testid="relay-problem"]')!.getAttribute('data-problem')).toBe('mismatch');
    expect(text('[data-testid="relay-problem"]')).toContain('answers to a different key');
    // Add this PC comes first (it keeps the other relay); Start fresh is the quiet second choice.
    expect(text('[data-testid="relay-fix"]')).toBe('Add this PC');
    expect(text('[data-testid="relay-fresh-open"]')).toBe('Start fresh on Cloudflare');
    // The delete never runs before the person confirms.
    await click(q('[data-testid="relay-fresh-open"]'));
    expect(q('[data-testid="relay-fresh-confirm"]')).not.toBeNull();
    expect(s.calls.some((c) => c.startsWith('delete'))).toBe(false);
    await click(q('[data-testid="relay-fresh-no"]'));
    expect(q('[data-testid="relay-fresh-confirm"]')).toBeNull();
    await click(q('[data-testid="relay-fresh-open"]'));
    // The plain warning names what is lost and who stops working, and the delete button waits for the typed name.
    expect(text('[data-testid="relay-fresh-warning"]')).toMatch(/deletes pm-relay/);
    expect(text('[data-testid="relay-fresh-warning"]')).toMatch(/phone, PC and teammate .* will stop working/);
    expect((q('[data-testid="relay-fresh-yes"]') as HTMLButtonElement).disabled).toBe(true);
    await type(q('[data-testid="relay-fresh-type"]') as HTMLInputElement, 'nope');
    expect((q('[data-testid="relay-fresh-yes"]') as HTMLButtonElement).disabled).toBe(true);
    await click(q('[data-testid="relay-fresh-yes"]'));
    expect(s.calls.some((c) => c.startsWith('delete'))).toBe(false);
    await type(q('[data-testid="relay-fresh-type"]') as HTMLInputElement, 'pm-relay');
    await click(q('[data-testid="relay-fresh-yes"]'));
    await settle(30);
    expect(s.calls).toContain(`delete@${WORKER}!`);
    expect(t.saved[1]).toEqual({ mode: 'stable', worker_url: WORKER, secret_action: 'regenerate', confirm_strand: true });
    expect(q('[data-testid="relay-sheet"]')!.getAttribute('data-phase')).toBe('done');
  });

  it('a relay that is on but not linked yet says so and Try again only checks again', async () => {
    let status = stable('waiting');
    const t = fakeTunnel(() => status);
    const s = fakeSteps();
    await mount(connectApi(t.api, s.updateApi));
    await click(q('[data-testid="relay-set-up"]'));
    await settle(60);
    expect(q('[data-testid="relay-problem"]')!.getAttribute('data-problem')).toBe('linking');
    const before = s.calls.length;
    status = stable('linked');
    t.api.getStatus = async () => status;
    await click(q('[data-testid="relay-fix"]'));
    await settle(10);
    expect(s.calls.length).toBe(before);
    expect(q('[data-testid="relay-sheet"]')!.getAttribute('data-phase')).toBe('done');
  });
});

describe('Set up my relay: safety', () => {
  const evil = [
    'https://evil.com/x.workers.dev',
    'https://evil.com/pm-relay.me.workers.dev',
    'https://a.b.c.workers.dev',
    'http://pm-relay.me.workers.dev',
    'https://pm-relay.me.workers.dev/path',
  ];
  for (const url of evil) {
    it('never saves or links ' + url, async () => {
      const t = fakeTunnel(stable('linked'));
      const s = fakeSteps({ deploy: { ok: true, output: 'deployed', url } });
      await runFromCard(t.api, s.updateApi);
      expect(t.saved).toEqual([]);
      expect(q('[data-testid="relay-problem"]')!.getAttribute('data-problem')).toBe('other');
    });
  }

  it('the address check is exact, and for one Worker name only', () => {
    expect(relayAddress('https://pm-relay.maya.workers.dev/')).toBe('https://pm-relay.maya.workers.dev');
    expect(relayAddress('https://Pm-Relay.maya.workers.dev', 'pm-relay')).toBe('https://pm-relay.maya.workers.dev');
    expect(relayAddress('https://other.maya.workers.dev', 'pm-relay')).toBeNull();
    for (const bad of ['https://evil.com/x.workers.dev', 'https://a.b.c.workers.dev', 'https://maya.workers.dev', 'https://pm-relay.maya.workers.dev.evil.com', 'https://pm-relay.maya.workers.dev?x=1', '']) expect(relayAddress(bad), bad).toBeNull();
  });

  it('a click outside the sheet and Escape do nothing while a setup runs; Cancel is the way out', async () => {
    let stop: (a: StepAnswer) => void = () => undefined;
    const pending = new Promise<StepAnswer>((r) => (stop = r));
    const base = fakeSteps().updateApi;
    const updateApi: UpdateApi = {
      ...base,
      step: (id, a, c) => (id === 'login' ? pending : base.step(id, a, c)),
      cancel: () => stop({ ok: false, output: 'Cancelled.' }),
    };
    await mount(connectApi(fakeTunnel(stable('linked')).api, updateApi));
    await click(q('[data-testid="relay-set-up"]'));
    await settle(8);
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await settle(3);
    expect(q('[data-testid="relay-sheet"]')).not.toBeNull();
    expect(q('[data-step="login"]')!.getAttribute('data-status')).toBe('running');
    await click(q('[data-testid="relay-cancel"]'));
    await settle(4);
    expect(q('[data-testid="relay-sheet"]')).toBeNull();
  });

  it('closing the sheet without Cancel (it goes away) still stops the running tool, once', async () => {
    let stop: (a: StepAnswer) => void = () => undefined;
    const pending = new Promise<StepAnswer>((r) => (stop = r));
    const cancels: number[] = [];
    const base = fakeSteps().updateApi;
    const updateApi: UpdateApi = {
      ...base,
      step: (id, a, c) => (id === 'login' ? pending : base.step(id, a, c)),
      cancel: () => {
        cancels.push(1);
        stop({ ok: false, output: 'Cancelled.' });
      },
    };
    const { RelaySetupSheet } = await import('./RelaySetup');
    const other = document.createElement('div');
    document.body.appendChild(other);
    const r2 = createRoot(other);
    await act(async () => r2.render(<RelaySetupSheet api={fakeTunnel(stable('linked')).api} updateApi={updateApi} onClose={() => undefined} />));
    await settle(6);
    expect(cancels).toHaveLength(0);
    await act(async () => r2.unmount());
    await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
    expect(cancels).toHaveLength(1);
  });

  it('a new setup waits for the cancelled one to stop its tool; two never overlap', async () => {
    let stop: (a: StepAnswer) => void = () => undefined;
    const pending = new Promise<StepAnswer>((r) => (stop = r));
    const base = fakeSteps();
    const prepares: number[] = [];
    let first = true;
    const updateApi: UpdateApi = {
      ...base.updateApi,
      step: (id, a, c) => {
        if (id === 'prepare') prepares.push(1);
        if (id === 'login' && first) {
          first = false;
          return pending;
        }
        return base.updateApi.step(id, a, c);
      },
      cancel: () => undefined, // the tool is slow to stop
    };
    const t = fakeTunnel(stable('linked'));
    await mount(connectApi(t.api, updateApi));
    await click(q('[data-testid="relay-set-up"]'));
    await settle(8);
    await click(q('[data-testid="relay-cancel"]'));
    await settle(3);
    await click(q('[data-testid="relay-set-up"]'));
    await settle(10);
    expect(prepares).toHaveLength(1); // the second sheet is waiting, not running its own prepare
    await act(async () => stop({ ok: false, output: 'Cancelled.' }));
    await settle(40);
    expect(prepares).toHaveLength(2);
    expect(q('[data-testid="relay-sheet"]')!.getAttribute('data-phase')).toBe('done');
  });

  it('keeps reading the link for about 45 seconds before saying it is not linked yet', async () => {
    vi.useFakeTimers();
    try {
      let reads = 0;
      const t = fakeTunnel(stable('waiting'));
      t.api.getStatus = async () => (++reads, stable('waiting'));
      const { RelaySetupSheet } = await import('./RelaySetup');
      await act(async () => root.render(<RelaySetupSheet api={t.api} updateApi={fakeSteps().updateApi} linkPollMs={1500} onClose={() => undefined} />));
      for (let i = 0; i < 40; i++) await act(async () => void (await vi.advanceTimersByTimeAsync(1500)));
      expect(reads).toBeGreaterThanOrEqual(28);
      expect(document.querySelector('[data-testid="relay-problem"]')!.getAttribute('data-problem')).toBe('linking');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Two PCs, one Cloudflare account', () => {
  it('a relay of another PC is found: nothing is put online, no Start fresh, one plain button: Add this PC', async () => {
    const t = fakeTunnel(stable('linked'));
    const s = fakeSteps({ look: { ok: true, output: 'A relay set up on another PC is already in this account.', taken: true } });
    await runFromCard(t.api, s.updateApi);
    expect(q('[data-testid="relay-problem"]')!.getAttribute('data-problem')).toBe('taken');
    expect(text('[data-testid="relay-problem"]')).toContain('already has a link that another PC set up');
    expect(text('[data-testid="relay-fix"]')).toBe('Add this PC');
    expect(q('[data-testid="relay-fresh-yes"]')).toBeNull();
    expect(text('[data-testid="relay-sheet"]')).not.toContain('Start fresh');
    expect(s.calls.some((c) => c.startsWith('deploy') || c.startsWith('delete'))).toBe(false);
    expect(t.saved).toEqual([]);
  });

  it('Add this PC deploys a separate relay named after this PC, and links to it', async () => {
    const t = fakeTunnel(stable('linked'));
    let looks = 0;
    const base = fakeSteps();
    const updateApi: UpdateApi = {
      ...base.updateApi,
      step: async (id, address, confirmed, name) => {
        if (id === 'look') return ++looks === 1 ? { ok: true, output: '', taken: true } : { ok: true, output: '' };
        if (id === 'deploy') return { ok: true, output: '', url: name ? `https://${name}.maya.workers.dev` : WORKER };
        return base.updateApi.step(id, address, confirmed, name);
      },
    };
    const names: (string | undefined)[] = [];
    const wrapped: UpdateApi = { ...updateApi, step: async (id, a, c, n) => (names.push(n), updateApi.step(id, a, c, n)) };
    await runFromCard(t.api, wrapped);
    await click(q('[data-testid="relay-fix"]'));
    await settle(30);
    const used = names.filter((n): n is string => !!n);
    expect(used.length).toBeGreaterThan(0);
    expect(new Set(used).size).toBe(1);
    expect(used[0]).toMatch(/^pm-relay-[a-z]{4}$/);
    expect(q('[data-testid="relay-sheet"]')!.getAttribute('data-phase')).toBe('done');
    expect(t.saved).toEqual([{ mode: 'stable', worker_url: `https://${used[0]}.maya.workers.dev`, secret: null, secret_action: 'keep' }]);
  });

  it('a key mismatch offers Add this PC first and it makes a separate relay, deleting nothing', async () => {
    let n = 0;
    const t = fakeTunnel(() => (++n === 1 ? stable('failed', { secret_mismatch: true, error: 'x' }) : stable('linked')));
    const s = fakeSteps();
    const inner = s.updateApi.step;
    s.updateApi.step = async (id, ad, c, nm) => (id === 'deploy' && nm ? { ok: true, output: '', url: `https://${nm}.maya.workers.dev` } : inner(id, ad, c, nm));
    await runFromCard(t.api, s.updateApi);
    expect(q('[data-testid="relay-problem"]')!.getAttribute('data-problem')).toBe('mismatch');
    await click(q('[data-testid="relay-fix"]'));
    await settle(30);
    expect(s.calls.some((c) => c.startsWith('delete'))).toBe(false);
    expect(s.names.filter(Boolean).every((x) => /^pm-relay-[a-z]{4}$/.test(x!))).toBe(true);
    expect(q('[data-testid="relay-sheet"]')!.getAttribute('data-phase')).toBe('done');
  });

  it('after our own deploy the check fails: Try again keeps the same name and never mints a second relay', async () => {
    const t = fakeTunnel(stable('linked'));
    let looks = 0;
    let checks = 0;
    const base = fakeSteps();
    const names: (string | undefined)[] = [];
    const updateApi: UpdateApi = {
      ...base.updateApi,
      step: async (id, a, c, n) => {
        names.push(n);
        if (id === 'look') return { ok: true, output: '', taken: ++looks === 1 };
        if (id === 'deploy') return { ok: true, output: '', url: n ? `https://${n}.maya.workers.dev` : WORKER };
        return base.updateApi.step(id, a, c, n);
      },
      check: async () => (++checks <= 3 ? { reachable: false, features: [], legacyLink: false } : { reachable: true, features: ['team'], legacyLink: false }),
    };
    await runFromCard(t.api, updateApi);
    await click(q('[data-testid="relay-fix"]')); // Add this PC: deploys, then the check fails 3 times
    await settle(30);
    expect(q('[data-testid="relay-problem"]')).not.toBeNull();
    const minted = new Set(names.filter(Boolean));
    expect(minted.size).toBe(1);
    await click(q('[data-testid="relay-fix"]')); // Try again
    await settle(30);
    expect(new Set(names.filter(Boolean))).toEqual(minted);
    expect(q('[data-testid="relay-sheet"]')!.getAttribute('data-phase')).toBe('done');
  });

  it('when our own relay name holds another key, Add this PC picks a NEW name', async () => {
    let saves = 0;
    const t = fakeTunnel(() => (++saves === 1 ? stable('failed', { secret_mismatch: true, error: 'x' }) : stable('linked')));
    const names: (string | undefined)[] = [];
    let looks = 0;
    const base = fakeSteps();
    const updateApi: UpdateApi = {
      ...base.updateApi,
      step: async (id, a, c, n) => {
        names.push(n);
        if (id === 'look') return { ok: true, output: '', taken: ++looks === 1 };
        if (id === 'deploy') return { ok: true, output: '', url: n ? `https://${n}.maya.workers.dev` : WORKER };
        return base.updateApi.step(id, a, c, n);
      },
    };
    await runFromCard(t.api, updateApi);
    await click(q('[data-testid="relay-fix"]')); // taken -> Add this PC (name 1); its link then answers with another key
    await settle(30);
    expect(q('[data-testid="relay-problem"]')!.getAttribute('data-problem')).toBe('mismatch');
    await click(q('[data-testid="relay-fix"]')); // Add this PC again: must not reuse name 1
    await settle(30);
    const used = [...new Set(names.filter((x): x is string => !!x))];
    expect(used.length).toBe(2);
    expect(q('[data-testid="relay-sheet"]')!.getAttribute('data-phase')).toBe('done');
  });

  it('a look that could not read the account stops with a plain retry, never a deploy', async () => {
    const s = fakeSteps({ look: { ok: false, output: 'Could not look at your Cloudflare account, so nothing was changed.' } });
    await runFromCard(fakeTunnel(stable('linked')).api, s.updateApi);
    expect(s.calls.some((c) => c.startsWith('deploy'))).toBe(false);
    expect(q('[data-testid="relay-problem"]')!.getAttribute('data-problem')).not.toBe('mismatch');
  });
});

describe('Set up my relay: plain words', () => {
  const FORBIDDEN_EN = /worker|tunnel|token|secret|durable/i;
  const FORBIDDEN_ZH = /worker|tunnel|token|secret|durable|通道|權杖|令牌|密鑰/i;
  // Cloudflare's own menu name, quoted as the person will see it on their page.
  const QUOTED_MENU = 'relaySetup.problem.subdomain';
  const defaults = (dict: Record<string, string>, bad: RegExp) =>
    Object.keys(en)
      .filter(
        (k) =>
          k.startsWith('relaySetup.') ||
          [
            'wu.step.prepare',
            'wu.step.install',
            'wu.step.login',
            'wu.step.look',
            'wu.step.delete',
            'wu.step.deploy',
            'wu.step.check',
            'wu.fresh',
            'wu.freshYes',
            'wu.freshNo',
          ].includes(k),
      )
      .filter((k) => k !== QUOTED_MENU)
      .filter((k) => bad.test(dict[k] ?? ''));
  it('the button, subtitle, progress and problem lines use no technical words (English and Traditional Chinese)', () => {
    expect(defaults(en as unknown as Record<string, string>, FORBIDDEN_EN)).toEqual([]);
    expect(defaults(zhTW as unknown as Record<string, string>, FORBIDDEN_ZH)).toEqual([]);
  });
  it('every new string has a Traditional Chinese twin with full-width punctuation', () => {
    for (const k of Object.keys(en).filter((x) => x.startsWith('relaySetup.'))) {
      const zh = (zhTW as unknown as Record<string, string>)[k];
      expect(zh, k).toBeTruthy();
      expect(zh, k).not.toMatch(/[一-鿿][,.:;?!]( |$)/);
    }
  });
  it('the Chinese screen shows the button in Traditional Chinese', async () => {
    setLanguagePref('zh-TW', false);
    await mount(connectApi(fakeTunnel(stable('linked')).api, fakeSteps().updateApi));
    expect(text('[data-testid="relay-set-up"]')).toBe('讓它隨處可用');
  });
});

describe('Nothing changes when a relay already exists', () => {
  it('no card, no button: just the status row', async () => {
    const tunnel: TunnelApi = { ...fakeTunnel(stable('linked')).api, getStatus: async () => stable('linked') };
    await mount(connectApi(tunnel, fakeSteps().updateApi));
    expect(q('[data-testid="relay-set-up"]')).toBeNull();
    expect(q('[data-testid="relay-set-up"]')).toBeNull();
    expect(text('[data-testid="connect-relay-host"]')).toBe('pm-relay.maya.workers.dev');
    expect(text('[data-testid="connect-relay-status"]')).toBe('Works anywhere');
  });
});
