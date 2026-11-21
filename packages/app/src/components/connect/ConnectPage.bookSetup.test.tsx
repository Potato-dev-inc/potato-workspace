// @vitest-environment jsdom
// Connect > This PC > My domain + Address book: the guided panel and the sentence for every state the Check can find.
// Through the real page; only the command layers are fakes. The Check replies are mocked, including fields this app does not know.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLanguagePref } from '../../i18n';
import type { TunnelConnectionTest, TunnelEvent, TunnelStatus } from '../../lib/tauri-types';
import { click, settle } from '../settings/test-utils';
import { fakeTunnel, harness, makeApi, q, stable, text, WORKER, type Harness } from './connect-test-utils';

vi.mock('qrcode', () => ({ default: { toCanvas: vi.fn(async () => undefined), toString: vi.fn(async () => '<svg xmlns="http://www.w3.org/2000/svg"/>') } }));

let h: Harness;
beforeEach(() => {
  window.localStorage.clear();
  setLanguagePref('en', false);
  h = harness();
});
afterEach(async () => {
  await h.unmount();
});

const D = 'tmux.example.com';
type Over = Omit<Partial<TunnelConnectionTest>, 'reason'> & { reason?: string; [extra: string]: unknown };
const reply = (over: Over): TunnelConnectionTest => ({ ok: false, url: `https://${D}`, http_status: 200, latency_ms: 4, message: 'backend english, never shown', ...over }) as TunnelConnectionTest;
const bookStatus = (over: Partial<TunnelStatus> = {}) =>
  stable('linked', {
    link_mode: 'domain',
    link_route: 'book',
    own_domain: `https://${D}`,
    own_domain_verified: false,
    local_port: 17425,
    book: { domain: `https://${D}`, supported: true, has_address: true, armed: true, link: 'waiting' },
    ...over,
  } as Partial<TunnelStatus>);

/** A tunnel that keeps its status like the app: a save of the link changes mode and route, a passing Check proves the name. */
function bookTunnel(first: TunnelStatus, answer: (n: number, route: string | undefined) => TunnelConnectionTest) {
  let current = first;
  const saves: Array<[string, string | null | undefined, string | null | undefined]> = [];
  let checks = 0;
  // Like the app: it remembers the route per name and restores it when a save sends none.
  let remembered: 'book' | 'direct' | null = first.link_mode === 'domain' ? (first.link_route ?? null) : null;
  const t = fakeTunnel(first, undefined, {
    getStatus: async () => current,
    setLinkMode: async (mode, domain, route) => {
      saves.push([mode, domain, route]);
      if (mode === 'domain' && route) remembered = route;
      current = { ...current, link_mode: mode, link_route: route ?? (mode === 'domain' ? (remembered ?? 'direct') : 'book'), own_domain_verified: false };
      return current;
    },
    checkDomain: async () => {
      checks += 1;
      const r = answer(checks, current.link_route);
      if (r.ok && r.reason !== 'is_direct') current = { ...current, own_domain_verified: true };
      return r;
    },
  });
  return { ...t, saves, checks: () => checks, status: () => current };
}

const panelText = () => text('[data-testid="connect-book-status-text"]');
const rowText = () => text('[data-testid="connect-relay-status"]');
const spinners = () => document.querySelectorAll('[data-testid="connect-relay"] [data-spinner], [data-testid="connect-relay"] .cx-dot.busy').length;
const mountWith = async (r: Over, status = bookStatus()) => {
  const t = bookTunnel(status, () => reply(r));
  await h.mount(makeApi({ tunnel: t.api }));
  await settle(4);
  return t;
};

describe('Address book panel: one sentence per state', () => {
  it('is_direct: says the name already works as Direct and offers Use Direct and Replace (no steps yet)', async () => {
    await mountWith({ reason: 'is_direct', ok: true });
    expect(panelText()).toBe(`${D} already goes straight to this PC (Direct). Use Direct, it works now. Or replace it with the Address book.`);
    expect(q('[data-testid="connect-book-use-direct"]')).not.toBeNull();
    expect(q('[data-testid="connect-book-replace"]')).not.toBeNull();
    expect(q('[data-testid="connect-book-steps"]')).toBeNull();
    // "goes straight to this PC" is a finding, never a pass for the Address book
    expect(q('[data-testid="connect-relay"]')!.getAttribute('data-state')).toBe('starting');
    expect(spinners()).toBe(0);
  });

  it('is_direct: Replace opens the steps; Use Direct switches this name to Direct and checks it again', async () => {
    const t = bookTunnel(bookStatus(), (n, route) => (route === 'direct' ? reply({ ok: true, reason: 'reached' }) : reply({ ok: true, reason: 'is_direct' })));
    await h.mount(makeApi({ tunnel: t.api }));
    await settle(4);
    await click(q('[data-testid="connect-book-replace"]'));
    expect(q('[data-testid="connect-book-steps"]')).not.toBeNull();
    await click(q('[data-testid="connect-book-use-direct"]'));
    await settle(6);
    expect(t.saves).toEqual([['domain', null, 'direct']]);
    expect(q('[data-testid="connect-link-route"]')!.getAttribute('data-route')).toBe('direct');
    // the name was asked again with Direct and passed
    // asked once for Book, once again for Direct (the route change re-runs the check; there is no second, timed ask)
    expect(t.checks()).toBe(2);
    expect(q('[data-testid="connect-relay"]')!.getAttribute('data-state')).toBe('working');
    expect(q('[data-testid="connect-book-setup"]')).toBeNull();
  });

  it('dns_taken: names the record (type and target) when the backend sends them, and a plainer line when it does not', async () => {
    await mountWith({ reason: 'dns_taken', dns_type: 'CNAME', dns_target: 'proxy.example.net' });
    expect(panelText()).toBe(`${D} is already used by a DNS record (CNAME -> proxy.example.net). Remove it in Cloudflare, or press Replace.`);
    expect(q<HTMLButtonElement>('[data-testid="connect-book-replace"]')!.disabled).toBe(true);
    await h.unmount();
    h = harness();
    await mountWith({ reason: 'dns_taken' });
    expect(panelText()).toBe(`${D} is already used by a DNS record. Remove it in Cloudflare, or press Replace.`);
  });

  it('no_worker: says it is another website and points at steps 1 and 2; the old backend sentence and the grey duplicate are gone', async () => {
    await mountWith({ reason: 'no_worker', http_status: 404 }, bookStatus({ book: { domain: `https://${D}`, supported: true, has_address: true, armed: false, link: 'waiting' } }));
    expect(panelText()).toBe(`${D} shows another website, not your Address book. Free the name (step 1), then set it up (step 2).`);
    expect(q('[data-testid="connect-domain-problem"]')).toBeNull();
    expect(rowText()).toBe(panelText());
    // the checklist does not repeat it as a grey "has to answer as your Worker" line
    await click(q('[data-testid="connect-details-toggle"]'));
    const stepsText = q('[data-testid="connect-steps"]')!.textContent ?? '';
    expect(stepsText).not.toContain('has to answer as your Worker');
    expect(stepsText.split('shows another website').length - 1).toBe(1);
    expect(q('[data-testid="connect-book-steps"]')).not.toBeNull();
    expect(spinners()).toBe(0);
  });

  it('other_key and unconfigured: one sentence, set it up again from this PC', async () => {
    for (const reason of ['other_key', 'unconfigured']) {
      await mountWith({ reason });
      expect(panelText(), reason).toBe(`${D} is an Address book made on another PC or with old settings. Set it up again from this PC.`);
      await h.unmount();
      h = harness();
    }
  });

  it('not_linked and stale: the telling line spins only while this PC really is telling the Worker', async () => {
    for (const reason of ['not_linked', 'stale']) {
      await mountWith({ reason }, bookStatus({ book: { domain: `https://${D}`, supported: true, has_address: true, armed: true, link: 'linking' } }));
      expect(panelText(), reason).toBe('Found your Address book. Telling it where this PC is…');
      expect(q('[data-testid="connect-book-status-icon"]')!.getAttribute('data-icon'), reason).toBe('busy');
      expect(q('[data-testid="connect-book-steps"]'), reason).toBeNull();
      await h.unmount();
      h = harness();
      // not telling yet (waiting): the same words, but no spinner
      await mountWith({ reason });
      expect(q('[data-testid="connect-book-status-icon"]')!.getAttribute('data-icon'), reason).toBe('idle');
      await h.unmount();
      h = harness();
    }
  });

  it('busy: its own still message (never "Telling it where this PC is") and no spinner', async () => {
    await mountWith({ reason: 'busy' }, bookStatus({ book: { domain: `https://${D}`, supported: true, has_address: true, armed: true, link: 'linking' } }));
    expect(panelText()).toBe('The Address book is busy. Wait a minute, then press Check.');
    expect(q('[data-testid="connect-book-status-icon"]')!.getAttribute('data-icon')).toBe('idle');
    expect(q('[data-testid="connect-book-steps"]')).toBeNull();
    setLanguagePref('zh-TW', false);
    await h.unmount();
    h = harness();
    await mountWith({ reason: 'busy' });
    expect(panelText()).toMatch(/位址簿/);
    expect(panelText()).not.toMatch(/Address book|check\./);
  });

  it('a final registration failure is shown, not hidden under a spinner', async () => {
    await mountWith({ reason: 'stale' }, bookStatus({ book: { domain: `https://${D}`, supported: true, has_address: true, armed: true, link: 'failed', reason: 'secret_mismatch' } }));
    expect(panelText()).toBe(`${D} keeps a different key. Deploy the Worker again with the settings from this app`);
    expect(q('[data-testid="connect-book-status-icon"]')!.getAttribute('data-icon')).toBe('bad');
  });

  it('tunnel_down: says the tunnel is not answering and Restart tunnel restarts it', async () => {
    const t = await mountWith({ reason: 'tunnel_down' });
    expect(panelText()).toBe("Your Address book points here, but this PC's tunnel is not answering.");
    expect(q('[data-testid="connect-book-status-icon"]')!.getAttribute('data-icon')).toBe('warn');
    await click(q('[data-testid="connect-book-restart"]'));
    await settle(3);
    expect(t.calls.restart).toBe(1);
  });

  it('zone_missing: names the zone that is not on this Cloudflare account', async () => {
    await mountWith({ reason: 'zone_missing' });
    expect(panelText()).toBe('example.com is not on this Cloudflare account. Add it there first.');
  });

  it('reached: Works, phones open the name; the row is working and the panel steps out of the way', async () => {
    await mountWith({ ok: true, reason: 'reached' });
    expect(rowText()).toBe(`Works. Phones open ${D}.`);
    expect(q('[data-testid="connect-relay"]')!.getAttribute('data-state')).toBe('working');
    expect(q('[data-testid="connect-book-setup"]')).toBeNull();
  });

  it('a Check reason this app has never heard of falls back to the plain line, never a raw key', async () => {
    await mountWith({ reason: 'something_new', extra_field: { a: 1 } });
    expect(panelText()).not.toMatch(/check\.|connect\./);
    expect(panelText().length).toBeGreaterThan(5);
  });
});

describe('Address book panel: the three steps', () => {
  it('shows free the name, put the Address book on it and check; the one-click slot is visible but off; no commands are shown', async () => {
    await mountWith({ reason: 'no_worker' });
    const steps = [...document.querySelectorAll('[data-testid="connect-book-steps"] > li')].map((li) => li.getAttribute('data-step'));
    expect(steps).toEqual(['free', 'put', 'check']);
    const forMe = q<HTMLButtonElement>('[data-testid="connect-book-for-me"]')!;
    expect(forMe.textContent).toBe('Set it up for me');
    expect(forMe.disabled).toBe(true);
    expect(q('[data-testid="connect-book-open-dns"]')!.getAttribute('data-href')).toContain('https://dash.cloudflare.com/');
    expect(q('[data-testid="connect-book-open-workers"]')!.getAttribute('data-href')).toContain('https://dash.cloudflare.com/');
    expect(q('[data-testid="connect-book-copy-worker"]')).not.toBeNull();
    expect(q('[data-testid="connect-book-copy-settings"]')).not.toBeNull();
    expect(text('[data-testid="connect-book-setup"]')).not.toMatch(/wrangler|npx|npm |curl|deploy -/i);
  });

  it('Check runs the Check now and shows live status while it runs (the only spinner)', async () => {
    let release: (r: TunnelConnectionTest) => void = () => undefined;
    let n = 0;
    const t = fakeTunnel(bookStatus(), undefined, {
      getStatus: async () => bookStatus(),
      setLinkMode: async () => bookStatus(),
      checkDomain: () => {
        n += 1;
        return n === 1 ? Promise.resolve(reply({ reason: 'no_worker' })) : new Promise<TunnelConnectionTest>((r) => (release = r));
      },
    });
    await h.mount(makeApi({ tunnel: t.api }));
    await settle(4);
    expect(q('[data-testid="connect-book-status-icon"]')!.getAttribute('data-icon')).toBe('bad');
    await click(q('[data-testid="connect-book-check"]'));
    expect(n).toBe(2);
    expect(q<HTMLButtonElement>('[data-testid="connect-book-check"]')!.disabled).toBe(true);
    expect(text('[data-testid="connect-book-check"]')).toBe('Checking…');
    expect(q('[data-testid="connect-book-status-icon"]')!.getAttribute('data-icon')).toBe('busy');
    release(reply({ ok: true, reason: 'reached' }));
    await settle(4);
    expect(q<HTMLButtonElement>('[data-testid="connect-book-check"]')?.disabled ?? false).toBe(false);
  });

  it('is in Traditional Chinese for every state (no English left, no raw key)', async () => {
    setLanguagePref('zh-TW', false);
    for (const reason of ['is_direct', 'dns_taken', 'no_worker', 'other_key', 'not_linked', 'tunnel_down', 'zone_missing']) {
      await mountWith({ reason, dns_type: 'CNAME', dns_target: 'x.example.net' });
      const all = q('[data-testid="connect-book-setup"]')!.textContent ?? '';
      expect(all, reason).toMatch(/[一-鿿]/);
      expect(all, reason).not.toMatch(/check\.|connect\.book/);
      expect(panelText(), reason).not.toMatch(/Address book|Cloudflare account|goes straight/);
      await h.unmount();
      h = harness();
    }
  });
});

describe('Address book: Edit, route memory, row state and Details', () => {
  it('Edit in Address book mode opens the panel (not the address sheet), also when the name works', async () => {
    await mountWith({ ok: true, reason: 'reached' }, bookStatus({ own_domain_verified: true }));
    expect(q('[data-testid="connect-book-setup"]')).toBeNull();
    await click(q('[data-testid="connect-link-domain-edit"]'));
    expect(q('[data-testid="connect-book-setup"]')).not.toBeNull();
    expect(q('[data-testid="own-domain-sheet"]')).toBeNull();
    // the address itself is still changed from the panel
    await click(q('[data-testid="connect-book-change"]'));
    expect(q('[data-testid="own-domain-sheet"]')).not.toBeNull();
  });

  it('Edit in Direct mode still opens the address sheet', async () => {
    await mountWith({ ok: true, reason: 'reached' }, bookStatus({ link_route: 'direct', own_domain_verified: true, book: null }));
    await click(q('[data-testid="connect-link-domain-edit"]'));
    expect(q('[data-testid="own-domain-sheet"]')).not.toBeNull();
    expect(q('[data-testid="connect-book-setup"]')).toBeNull();
  });

  it('picking My domain again keeps a saved Address book route (it is not reset to Direct)', async () => {
    const t = bookTunnel(bookStatus({ own_domain_verified: true }), () => reply({ ok: true, reason: 'reached' }));
    await h.mount(makeApi({ tunnel: t.api }));
    await settle(4);
    await click(q('[data-testid="connect-link-permanent"]'));
    await settle(4);
    await click(q('[data-testid="connect-link-domain"]'));
    await settle(4);
    expect(t.saves.map((s) => s[0])).toEqual(['permanent', 'domain']);
    // the screen sends no route: the app's own per-name memory decides (a screen-side copy leaked a route across names)
    expect(t.saves[1]).toEqual(['domain', null, null]);
    expect(q('[data-testid="connect-link-route"]')!.getAttribute('data-route')).toBe('book');
  });

  it('a fresh start in Permanent with nothing remembered lets the app decide the route (null, not a forced Direct)', async () => {
    const t = bookTunnel(stable('linked', { link_mode: 'permanent', own_domain: `https://${D}`, local_port: 17425 } as Partial<TunnelStatus>), () => reply({ ok: true, reason: 'reached' }));
    await h.mount(makeApi({ tunnel: t.api }));
    await settle(3);
    await click(q('[data-testid="connect-link-domain"]'));
    await settle(3);
    expect(t.saves[0]).toEqual(['domain', null, null]);
  });

  it('a pass for Direct does not carry into the Address book after a route change', async () => {
    let release: (r: TunnelConnectionTest) => void = () => undefined;
    const t = bookTunnel(bookStatus({ link_route: 'direct', own_domain_verified: true, book: null }), (n, route) => (route === 'direct' ? reply({ ok: true, reason: 'reached' }) : (undefined as never)));
    const api = { ...t.api, checkDomain: (d: string) => (t.status().link_route === 'direct' ? t.api.checkDomain!(d) : new Promise<TunnelConnectionTest>((res) => (release = res))) };
    await h.mount(makeApi({ tunnel: api as typeof t.api }));
    await settle(4);
    await click(q('[data-testid="connect-route-book"]'));
    await settle(4);
    expect(q('[data-testid="connect-book-status"]')!.getAttribute('data-state')).toBe('checking');
    expect(q('[data-testid="connect-relay"]')!.textContent).not.toContain('Works. Phones open');
    release(reply({ reason: 'no_worker' }));
    await settle(4);
  });

  it('the relay Update button is not shown in My domain', async () => {
    const t = bookTunnel(bookStatus({ own_domain_verified: true }), () => reply({ ok: true, reason: 'reached' }));
    await h.mount(makeApi({ tunnel: t.api, settings: { far_pcs_enabled: true }, workerHealth: (async () => ({ reachable: true, features: ['team', 'stable-link'], legacyLink: false })) as never }));
    await settle(4);
    expect(q('[data-testid="connect-relay-pair-update-go"]')).toBeNull();
    expect(text('[data-testid="connect-relay-status"]')).not.toContain('need an update');
  });

  it('only one "Not checked yet" shows: the panel line, not the grey note as well', async () => {
    await mountWith({ ok: false, reason: 'unreachable' }, bookStatus());
    await h.unmount();
    h = harness();
    const t = bookTunnel(bookStatus({ own_domain_verified: false }), () => new Promise(() => undefined) as never);
    await h.mount(makeApi({ tunnel: { ...t.api, checkDomain: () => new Promise(() => undefined) } as typeof t.api }));
    await settle(2);
    expect(q('[data-testid="connect-domain-unchecked"]')).toBeNull();
  });

  it('the row follows only the name: a failed Permanent relay does not turn it broken, a passed name is working', async () => {
    const failedRelay = { worker_url: WORKER, quick_url: 'https://quick-one.trycloudflare.com', link: 'failed', error: 'x', reason: 'secret_mismatch' } as TunnelStatus['stable'];
    await mountWith({ reason: 'no_worker' }, bookStatus({ stable: failedRelay }));
    expect(q('[data-testid="connect-relay"]')!.getAttribute('data-state')).toBe('starting');
    expect(q('[data-testid="connect-relay-fix"]')).toBeNull();
    expect(q('[data-testid="connect-relay-again"]')).toBeNull();
    await h.unmount();
    h = harness();
    await mountWith({ ok: true, reason: 'reached' }, bookStatus({ stable: failedRelay, own_domain_verified: true }));
    expect(q('[data-testid="connect-relay"]')!.getAttribute('data-state')).toBe('working');
    expect(q('[data-testid="connect-row-icon"]')!.getAttribute('data-icon')).toBe('ok');
  });

  const events: TunnelEvent[] = [
    { at_ms: 1000, code: 'relay_failed', reason: 'worker_too_old' },
    { at_ms: 2000, code: 'relay_linked' },
    { at_ms: 3000, code: 'book_linked', host: D },
    { at_ms: 4000, code: 'book_failed', host: D, reason: 'secret_mismatch' },
    { at_ms: 5000, code: 'book_failed', host: D, reason: 'a_reason_from_the_future' },
    { at_ms: 6000, code: 'book_failed', host: D, reason: 'is_direct' },
  ];
  it('Details: no relay lines while My domain is on; the Address book lines are there', async () => {
    await mountWith({ ok: true, reason: 'reached' }, bookStatus({ own_domain_verified: true, events } as Partial<TunnelStatus>));
    await click(q('[data-testid="connect-details-toggle"]'));
    const lines = text('[data-testid="connect-events"]');
    expect(lines).not.toMatch(/relay/);
    expect(lines).toContain(`${D}: knows where this PC is`);
    expect(lines).toContain(`${D}: it has another secret`);
    expect(lines).not.toMatch(/check\.|a_reason_from_the_future/);
    expect(lines).toContain(`${D} already goes straight to this PC (Direct)`);
  });

  it('Details: in Permanent mode the relay lines show and the Address book lines do not', async () => {
    const t = bookTunnel(stable('linked', { link_mode: 'permanent', local_port: 17425, events } as Partial<TunnelStatus>), () => reply({ ok: true, reason: 'reached' }));
    await h.mount(makeApi({ tunnel: t.api }));
    await settle(3);
    await click(q('[data-testid="connect-details-toggle"]'));
    const lines = text('[data-testid="connect-events"]');
    expect(lines).toContain('relay: ');
    expect(lines).not.toContain(`${D}:`);
  });
});

describe('layout: the link-mode row (jsdom has no layout, so the rules and classes are checked)', () => {
  it('the row is the single-column kind and the heading and route block carry the classes the CSS rules fix', async () => {
    await mountWith({ ok: true, reason: 'reached' }, bookStatus({ own_domain_verified: true }));
    const row = q('[data-testid="connect-link-mode"]')!;
    expect(row.classList.contains('cx-row-stack')).toBe(true);
    expect(row.classList.contains('cx-row-wide')).toBe(false);
    expect(row.querySelector('.cx-name')!.textContent).toBe('How your phone reaches this PC');
    expect(row.querySelector('.cx-route')).not.toBeNull();
  });
});
