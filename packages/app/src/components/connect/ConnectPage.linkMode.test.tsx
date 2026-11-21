// @vitest-environment jsdom
// Connect > Devices > This PC: "Permanent link" / "Temporary link". One control on the existing card, no restart, the saved Worker stays,
// a plain note that phones on the other link must be added again. An own-domain Worker is a relay like a workers.dev one.
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLanguagePref } from '../../i18n';
import type { TunnelStatus } from '../../lib/tauri-types';
import { click, settle, type } from '../settings/test-utils';
import { fakeTunnel, harness, makeApi, q, stable, text, type Harness } from './connect-test-utils';

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

/** A tunnel whose switch behaves like the app's: it flips `link_temporary` and keeps the Worker setting and its link. */
function switchable(first: TunnelStatus) {
  let current = first;
  const seen: boolean[] = [];
  const t = fakeTunnel(first, undefined, {
    getStatus: async () => current,
    setTemporary: async (on: boolean) => {
      seen.push(on);
      current = { ...current, link_temporary: on };
      return current;
    },
  });
  return { ...t, seen };
}

describe('This PC: permanent or temporary link', () => {
  it('shows one switch with plain words, permanent by default, and no restart on a switch', async () => {
    const t = switchable(stable('linked'));
    await h.mount(makeApi({ tunnel: t.api }));
    expect(q('[data-testid="connect-link-mode"]')).not.toBeNull();
    expect(q('[data-testid="connect-link-permanent"]')!.getAttribute('aria-checked')).toBe('true');
    expect(text('[data-testid="connect-link-note"]')).toContain('same address');
    expect(q('[data-testid="connect-link-repair"]')).toBeNull();
    await click(q('[data-testid="connect-link-temporary"]'));
    await settle(4);
    expect(t.seen).toEqual([true]);
    expect(t.calls.restart).toBe(0);
    expect(q('[data-testid="connect-link-temporary"]')!.getAttribute('aria-checked')).toBe('true');
    expect(text('[data-testid="connect-link-note"]')).toContain('changes when this PC restarts');
    // Temporary: the chip shows the plain quick address phones use, never the Worker
    expect(text('[data-testid="connect-relay-host"]')).toBe('quick-one.trycloudflare.com');
    expect(q('[data-testid="connect-link-repair"]')!.textContent).toContain('added again');
  });

  it('switching back is one tap and the same note appears (phones on the other link need to be added again)', async () => {
    const t = switchable(stable('linked', { link_temporary: true }));
    await h.mount(makeApi({ tunnel: t.api }));
    expect(q('[data-testid="connect-link-temporary"]')!.getAttribute('aria-checked')).toBe('true');
    await click(q('[data-testid="connect-link-permanent"]'));
    await settle(4);
    expect(t.seen).toEqual([false]);
    expect(q('[data-testid="connect-link-permanent"]')!.getAttribute('aria-checked')).toBe('true');
    expect(q('[data-testid="connect-link-repair"]')).not.toBeNull();
  });

  it('pressing the mode that is already on does nothing', async () => {
    const t = switchable(stable('linked'));
    await h.mount(makeApi({ tunnel: t.api }));
    await click(q('[data-testid="connect-link-permanent"]'));
    await settle(2);
    expect(t.seen).toEqual([]);
  });

  it('no Worker yet: the switch is there, Permanent is off, the plain address shows as chosen, and the setup button stays', async () => {
    const t = switchable({ ...stable('linked'), mode: 'quick', config: { mode: 'quick', hostname: null, url: null, has_token: false }, stable: null } as TunnelStatus);
    await h.mount(makeApi({ tunnel: t.api }));
    expect(q('[data-testid="connect-link-mode"]')).not.toBeNull();
    expect(q<HTMLButtonElement>('[data-testid="connect-link-permanent"]')!.disabled).toBe(true);
    expect(q('[data-testid="connect-link-temporary"]')!.getAttribute('aria-checked')).toBe('true');
    expect(q('[data-testid="relay-set-up"]')).not.toBeNull();
    await click(q('[data-testid="connect-link-permanent"]'));
    expect(t.seen).toEqual([]);
  });

  it('a Worker on the own domain of the person is the relay too (nothing is tied to workers.dev)', async () => {
    const own = 'https://phone.example.com';
    const base = stable('linked');
    const t = switchable({ ...base, config: { ...base.config, url: own }, stable: { ...base.stable!, worker_url: own } });
    await h.mount(makeApi({ tunnel: t.api }));
    expect(q('[data-testid="connect-relay"]')!.getAttribute('data-state')).toBe('working');
    expect(text('[data-testid="connect-relay-host"]')).toBe('phone.example.com');
    expect(q('[data-testid="connect-link-mode"]')).not.toBeNull();
  });
});

/** A tunnel that behaves like the app for the three links: the Worker setting and the typed address are never lost by a switch. */
function threeWay(first: TunnelStatus, reach: { ok: boolean; message: string } = { ok: true, message: 'ok' }) {
  let current: TunnelStatus = { ...first, link_mode: first.link_mode ?? 'permanent', own_domain: first.own_domain ?? null, own_domain_verified: first.own_domain_verified ?? false, local_port: 17425 };
  // like the app: only a passing Check proves an address; typing another one makes it unproven again
  let proven: string | null = first.own_domain_verified ? (first.own_domain ?? null) : null;
  const refresh = () => {
    current = { ...current, own_domain_verified: proven !== null && proven === current.own_domain };
  };
  const calls: Array<[string, string | null | undefined]> = [];
  const routes: Array<string | null> = [];
  const checks: string[] = [];
  const ports: Array<number | null> = [];
  const t = fakeTunnel(first, undefined, {
    getStatus: async () => current,
    setPhonePort: async (port: number | null) => {
      ports.push(port);
      current = { ...current, chosen_port: port };
      return current;
    },
    setLinkMode: async (mode, domain, route) => {
      calls.push([mode, domain]);
      routes.push(route ?? null);
      current = { ...current, link_mode: mode, link_temporary: mode === 'temporary', own_domain: domain ?? current.own_domain ?? null, link_route: route ?? (mode === 'domain' ? 'direct' : 'book') };
      refresh();
      return current;
    },
    checkDomain: async (address: string) => {
      checks.push(address);
      if (reach.ok) {
        proven = address;
        refresh();
      }
      return { ok: reach.ok, url: address, http_status: reach.ok ? 200 : null, latency_ms: 3, message: reach.message };
    },
  });
  return { ...t, calls, routes, checks, ports, status: () => current };
}

const mode = () => q('[data-testid="connect-link-mode"]')!.getAttribute('data-mode');

describe('This PC: three links (permanent, temporary, my domain)', () => {
  it('shows three choices; My domain with no saved address opens the small sheet and does not switch', async () => {
    const t = threeWay(stable('linked'));
    await h.mount(makeApi({ tunnel: t.api }));
    expect(['connect-link-permanent', 'connect-link-temporary', 'connect-link-domain'].every((id) => q(`[data-testid="${id}"]`) !== null)).toBe(true);
    expect(mode()).toBe('permanent');
    await click(q('[data-testid="connect-link-domain"]'));
    await settle(3);
    expect(q('[data-testid="own-domain-sheet"]')).not.toBeNull();
    expect(t.calls).toEqual([]);
    expect(mode()).toBe('permanent');
    // the sheet says where to point the address, in plain words
    expect(text('[data-testid="own-domain-local"]')).toBe('http://127.0.0.1:17425');
    expect(text('[data-testid="own-domain-sheet"]')).toContain('Point it at this PC');
    expect(text('[data-testid="own-domain-sheet"]')).not.toMatch(/proxy|tunnel|stable|custom|relay|worker/i);
  });

  it('the port in the Point-it-at line is edited right there, checked, applied at once, and says it needs a restart', async () => {
    const t = threeWay(stable('linked'));
    await h.mount(makeApi({ tunnel: t.api }));
    await click(q('[data-testid="connect-link-domain"]'));
    expect(text('[data-testid="own-domain-local"]')).toBe('http://127.0.0.1:17425');
    expect(q('[data-testid="own-domain-port-pending"]')).toBeNull();
    await click(q('[data-testid="own-domain-port-edit"]'));
    const port = () => q<HTMLInputElement>('[data-testid="own-domain-port"]')!;
    const apply = () => q<HTMLButtonElement>('[data-testid="own-domain-port-apply"]')!;
    for (const bad of ['80', '65536', 'abc']) {
      await type(port(), bad);
      expect(q('[data-testid="own-domain-port-problem"]'), bad).not.toBeNull();
      expect(apply().disabled, bad).toBe(true);
    }
    await type(port(), '17500');
    expect(apply().disabled).toBe(false);
    await click(apply());
    await settle(4);
    expect(t.ports).toEqual([17500]);
    expect(text('[data-testid="own-domain-local"]')).toBe('http://127.0.0.1:17500');
    expect(text('[data-testid="own-domain-port-pending"]')).toContain('restart');
    expect(q('[data-testid="own-domain-sheet"]')).not.toBeNull();
    await click(q('[data-testid="own-domain-port-edit"]'));
    await click(q('[data-testid="own-domain-port-auto"]'));
    await settle(4);
    expect(t.ports).toEqual([17500, null]);
    expect(text('[data-testid="own-domain-local"]')).toBe('http://127.0.0.1:17425');
    expect(q('[data-testid="own-domain-port-pending"]')).toBeNull();
  });

  it('Save is off until the address is usable; a bad address gets a plain reason', async () => {
    const t = threeWay(stable('linked'));
    await h.mount(makeApi({ tunnel: t.api }));
    await click(q('[data-testid="connect-link-domain"]'));
    const input = q<HTMLInputElement>('[data-testid="own-domain-input"]')!;
    const save = () => q<HTMLButtonElement>('[data-testid="own-domain-save"]')!;
    expect(save().disabled).toBe(true);
    await type(input, 'http://phone.example.com');
    await act(async () => {
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(save().disabled).toBe(true);
    await type(input, '192.168.1.4');
    expect(save().disabled).toBe(true);
    await type(input, 'pm-relay.maya.workers.dev');
    expect(save().disabled).toBe(true);
    await type(input, 'Phone.Example.com/anything?x=1');
    expect(save().disabled).toBe(false);
  });

  it('Check asks the typed address (cleaned) and says plainly whether it reaches this PC', async () => {
    const t = threeWay(stable('linked'), { ok: false, message: 'Not reachable yet. Check that the name points at this PC and try again.' });
    await h.mount(makeApi({ tunnel: t.api }));
    await click(q('[data-testid="connect-link-domain"]'));
    await type(q<HTMLInputElement>('[data-testid="own-domain-input"]')!, 'HTTPS://Phone.Example.com/x');
    await click(q('[data-testid="own-domain-check"]'));
    await settle(4);
    expect(t.checks).toEqual(['https://phone.example.com']);
    expect(text('[data-testid="own-domain-result"]')).toContain('Not reachable yet');
    // nothing was saved by checking
    expect(t.calls).toEqual([]);
  });

  it('Save keeps the address, turns My domain on, closes the sheet and the row says it works', async () => {
    const t = threeWay(stable('linked'));
    await h.mount(makeApi({ tunnel: t.api }));
    await click(q('[data-testid="connect-link-domain"]'));
    await type(q<HTMLInputElement>('[data-testid="own-domain-input"]')!, 'phone.example.com');
    await click(q('[data-testid="own-domain-save"]'));
    await settle(6);
    expect(t.calls).toEqual([['domain', 'https://phone.example.com']]);
    expect(q('[data-testid="own-domain-sheet"]')).toBeNull();
    expect(mode()).toBe('domain');
    expect(q('[data-testid="connect-link-domain"]')!.getAttribute('aria-checked')).toBe('true');
    expect(text('[data-testid="connect-link-note"]')).toContain('your own web address');
    expect(text('[data-testid="connect-relay-host"]')).toBe('phone.example.com');
    expect(text('[data-testid="connect-relay-status"]')).toContain('your own address');
    expect(q('[data-testid="connect-link-domain-edit"]')).not.toBeNull();
  });

  it('switching never loses the other settings: back to permanent keeps the Worker, My domain again needs no typing', async () => {
    const t = threeWay(stable('linked', { link_mode: 'domain', own_domain: 'https://phone.example.com' } as Partial<TunnelStatus>));
    await h.mount(makeApi({ tunnel: t.api }));
    expect(mode()).toBe('domain');
    await click(q('[data-testid="connect-link-permanent"]'));
    await settle(4);
    expect(mode()).toBe('permanent');
    // the Worker is untouched: still the card's address, no restart, no save of a tunnel setting
    expect(text('[data-testid="connect-relay-host"]')).toBe('pm-relay.maya.workers.dev');
    expect(t.calls.at(-1)).toEqual(['permanent', null]);
    expect(t.calls.length).toBe(1);
    expect(t.status().config.mode).toBe('stable');
    expect(t.status().own_domain).toBe('https://phone.example.com');
    await click(q('[data-testid="connect-link-temporary"]'));
    await settle(4);
    expect(mode()).toBe('temporary');
    expect(t.status().own_domain).toBe('https://phone.example.com');
    // the typed address is remembered: one tap, no sheet
    await click(q('[data-testid="connect-link-domain"]'));
    await settle(4);
    expect(q('[data-testid="own-domain-sheet"]')).toBeNull();
    expect(mode()).toBe('domain');
    expect(t.calls.at(-1)).toEqual(['domain', null]);
  });

  it('Edit opens the sheet with the saved address filled in, and saving a new one replaces it', async () => {
    const t = threeWay(stable('linked', { link_mode: 'permanent', own_domain: 'https://phone.example.com' } as Partial<TunnelStatus>));
    await h.mount(makeApi({ tunnel: t.api }));
    await click(q('[data-testid="connect-link-domain-edit"]'));
    expect(q<HTMLInputElement>('[data-testid="own-domain-input"]')!.value).toBe('phone.example.com');
    await type(q<HTMLInputElement>('[data-testid="own-domain-input"]')!, 'home.example.org');
    await click(q('[data-testid="own-domain-save"]'));
    await settle(6);
    expect(t.calls).toEqual([['domain', 'https://home.example.org']]);
    expect(t.status().own_domain).toBe('https://home.example.org');
  });

  it('an own address that does not reach this PC shows a plain line and does not turn the row into "Fix it"', async () => {
    const t = threeWay(stable('linked', { link_mode: 'domain', own_domain: 'https://phone.example.com' } as Partial<TunnelStatus>), { ok: false, message: 'The address is there, but it cannot reach this PC yet.' });
    await h.mount(makeApi({ tunnel: t.api }));
    await settle(4);
    expect(text('[data-testid="connect-relay-status"]')).toContain('does not reach this PC yet');
    // the name's one line says it; the backend's English sentence is not shown a second time
    expect(q('[data-testid="connect-domain-problem"]')).toBeNull();
    expect(q('[data-testid="connect-relay-fix"]')).toBeNull();
    // the row follows only the name's pass: not passed means "starting", whatever the Permanent relay does
    expect(q('[data-testid="connect-relay"]')!.getAttribute('data-state')).toBe('starting');
  });
});

describe('This PC: My domain is advertised only after a passing Check', () => {
  it('a saved address that fails Check is kept but not given to phones: "Not checked yet" and the row does not claim it works', async () => {
    const t = threeWay(stable('linked'), { ok: false, message: 'Not reachable yet.' });
    await h.mount(makeApi({ tunnel: t.api }));
    await click(q('[data-testid="connect-link-domain"]'));
    await type(q<HTMLInputElement>('[data-testid="own-domain-input"]')!, 'phone.example.com');
    await click(q('[data-testid="own-domain-save"]'));
    await settle(6);
    expect(t.calls).toEqual([['domain', 'https://phone.example.com']]);
    expect(t.status().own_domain).toBe('https://phone.example.com');
    expect(t.status().own_domain_verified).toBe(false);
    expect(text('[data-testid="connect-domain-unchecked"]')).toContain('Not checked yet');
    expect(text('[data-testid="connect-relay-status"]')).not.toContain('your own address');
    // the domain is not shown as the way in; the chip gives where to point it, and so does Copy
    expect(text('[data-testid="connect-relay-status"]')).toContain('does not reach this PC yet');
    expect(text('[data-testid="connect-relay-host"]')).toBe('127.0.0.1:17425');
    expect(text('[data-testid="connect-relay-host"]')).not.toContain('example.com');
  });

  it('Copy of an unproven address copies the local address, never the domain', async () => {
    const writes: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (v: string) => void writes.push(v) }, configurable: true });
    const t = threeWay(stable('linked', { link_mode: 'domain', own_domain: 'https://phone.example.com' } as Partial<TunnelStatus>), { ok: false, message: 'Not reachable yet.' });
    await h.mount(makeApi({ tunnel: t.api }));
    await settle(4);
    await click(q('[data-testid="relay-menu-copy"]'));
    await settle(2);
    expect(writes).toEqual(['http://127.0.0.1:17425']);
  });

  it('a proven address is the way in: its name shows and Copy copies it', async () => {
    const writes: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (v: string) => void writes.push(v) }, configurable: true });
    const t = threeWay(stable('linked', { link_mode: 'domain', own_domain: 'https://phone.example.com', own_domain_verified: true } as Partial<TunnelStatus>));
    await h.mount(makeApi({ tunnel: t.api }));
    await settle(4);
    expect(text('[data-testid="connect-relay-host"]')).toBe('phone.example.com');
    await click(q('[data-testid="relay-menu-copy"]'));
    await settle(2);
    expect(writes).toEqual(['https://phone.example.com']);
  });

  it('a passing Check proves it (the app records it), and the Not checked yet line goes away', async () => {
    const t = threeWay(stable('linked'));
    await h.mount(makeApi({ tunnel: t.api }));
    await click(q('[data-testid="connect-link-domain"]'));
    await type(q<HTMLInputElement>('[data-testid="own-domain-input"]')!, 'phone.example.com');
    await click(q('[data-testid="own-domain-check"]'));
    await settle(4);
    expect(text('[data-testid="own-domain-result"]')).toContain('reaches this PC');
    await click(q('[data-testid="own-domain-save"]'));
    await settle(8);
    expect(t.status().own_domain_verified).toBe(true);
    expect(q('[data-testid="connect-domain-unchecked"]')).toBeNull();
  });

  it('editing the address makes it unproven again until it passes Check', async () => {
    const t = threeWay(stable('linked', { link_mode: 'domain', own_domain: 'https://phone.example.com', own_domain_verified: true } as Partial<TunnelStatus>), { ok: false, message: 'Not reachable yet.' });
    await h.mount(makeApi({ tunnel: t.api }));
    await click(q('[data-testid="connect-link-domain-edit"]'));
    await type(q<HTMLInputElement>('[data-testid="own-domain-input"]')!, 'other.example.com');
    await click(q('[data-testid="own-domain-save"]'));
    await settle(8);
    expect(t.status().own_domain).toBe('https://other.example.com');
    expect(t.status().own_domain_verified).toBe(false);
    expect(q('[data-testid="connect-domain-unchecked"]')).not.toBeNull();
  });

  it('this computer is refused in the sheet, in any form', async () => {
    const t = threeWay(stable('linked'));
    await h.mount(makeApi({ tunnel: t.api }));
    await click(q('[data-testid="connect-link-domain"]'));
    const input = q<HTMLInputElement>('[data-testid="own-domain-input"]')!;
    for (const name of ['localhost', 'https://localhost:8443', 'app.localhost', '0x7f.1', 'example.123']) {
      await type(input, name);
      expect(q<HTMLButtonElement>('[data-testid="own-domain-save"]')!.disabled, name).toBe(true);
    }
  });

  it('with no Worker, My domain still works and the row shows it as the way in', async () => {
    const quickOnly = { ...stable('linked'), mode: 'quick', config: { mode: 'quick', hostname: null, url: null, has_token: false }, stable: null } as TunnelStatus;
    const t = threeWay(quickOnly);
    await h.mount(makeApi({ tunnel: t.api }));
    await click(q('[data-testid="connect-link-domain"]'));
    await type(q<HTMLInputElement>('[data-testid="own-domain-input"]')!, 'phone.example.com');
    await click(q('[data-testid="own-domain-save"]'));
    await settle(8);
    expect(mode()).toBe('domain');
    // the fake's auto-check passes, so the address is proven and the row works through it
    expect(q('[data-testid="connect-relay"]')!.getAttribute('data-state')).toBe('working');
    expect(text('[data-testid="connect-relay-host"]')).toBe('phone.example.com');
    expect(q('[data-testid="connect-link-permanent"]')!.hasAttribute('disabled')).toBe(true);
  });
});

describe('This PC: the link route (Address book or Direct)', () => {
  const domainStatus = () => stable('linked', { link_mode: 'domain', own_domain: 'https://phone.example.com', own_domain_verified: true } as Partial<TunnelStatus>);

  it('Permanent link: Address book is on by default (no route saved), Direct is Coming and cannot be chosen', async () => {
    const t = threeWay(stable('linked'));
    await h.mount(makeApi({ tunnel: t.api }));
    expect(q('[data-testid="connect-link-route"]')!.getAttribute('data-route')).toBe('book');
    expect(q('[data-testid="connect-route-book"]')!.getAttribute('aria-checked')).toBe('true');
    const direct = q<HTMLButtonElement>('[data-testid="connect-route-direct"]')!;
    expect(direct.getAttribute('aria-checked')).toBe('false');
    expect(direct.disabled).toBe(true);
    expect(direct.textContent).toContain('Coming');
    expect(text('[data-testid="connect-route-note"]')).toBe('Your address only says where this PC is. Phones then connect straight to it.');
    await click(direct);
    await settle(2);
    expect(t.calls).toEqual([]);
    expect(t.routes).toEqual([]);
    expect(q('[data-testid="connect-route-book"]')!.getAttribute('aria-checked')).toBe('true');
  });

  it('My domain: Direct is on by default (no route saved), and the Address book is built, so it can be chosen and is saved', async () => {
    const t = threeWay(domainStatus());
    await h.mount(makeApi({ tunnel: t.api }));
    expect(q('[data-testid="connect-route-direct"]')!.getAttribute('aria-checked')).toBe('true');
    expect(q('[data-testid="connect-book-setup"]')).toBeNull();
    const book = q<HTMLButtonElement>('[data-testid="connect-route-book"]')!;
    expect(book.disabled).toBe(false);
    expect(book.textContent).not.toContain('Coming');
    expect(text('[data-testid="connect-route-note"]')).toBe('Your address carries everything itself.');
    await click(book);
    await settle(3);
    expect(t.calls).toEqual([['domain', null]]);
    expect(t.routes).toEqual(['book']);
    expect(q('[data-testid="connect-link-route"]')!.getAttribute('data-route')).toBe('book');
    // the Direct pass does not count for the Address book in the app, but this fake keeps it: the panel opens through Edit
    await click(q('[data-testid="connect-link-domain-edit"]'));
    expect(q('[data-testid="connect-book-setup"]')).not.toBeNull();
  });

  it('My domain + Address book: the Worker files can be copied (never the key), and the live steps are the Address book ones', async () => {
    const t = threeWay(stable('linked', { link_mode: 'domain', link_route: 'book', own_domain: 'https://phone.example.com', own_domain_verified: true, book: { domain: 'https://phone.example.com', supported: true, has_address: true, link: 'linked' } } as Partial<TunnelStatus>));
    const asked: string[] = [];
    t.api.domainBookFiles = async (domain: string) => {
      asked.push(domain);
      return { host: 'phone.example.com', worker_js: 'export default {}; // worker', wrangler_toml: 'name = "pm-address-book"' };
    };
    const written: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (s: string) => void written.push(s) } });
    await h.mount(makeApi({ tunnel: t.api }));
    expect(q('[data-testid="connect-link-route"]')!.getAttribute('data-route')).toBe('book');
    expect(text('[data-testid="connect-link-note"]')).toContain('small Worker');
    // a name that works keeps the panel closed; Edit opens it (and does not open the address sheet)
    expect(q('[data-testid="connect-book-setup"]')).toBeNull();
    await click(q('[data-testid="connect-link-domain-edit"]'));
    expect(q('[data-testid="own-domain-sheet"]')).toBeNull();
    expect(text('[data-testid="connect-book-setup"]')).toContain('phone.example.com');
    await click(q('[data-testid="connect-book-copy-worker"]'));
    await settle(3);
    await click(q('[data-testid="connect-book-copy-settings"]'));
    await settle(3);
    expect(asked).toEqual(['https://phone.example.com', 'https://phone.example.com']);
    expect(written).toEqual(['export default {}; // worker', 'name = "pm-address-book"']);
    expect(text('[data-testid="connect-book-copied"]')).toBe('Copied.');
    // the live list names the real Address book steps
    await click(q('[data-testid="connect-steps-toggle"]'));
    const steps = (q('[data-testid="connect-steps"]') ?? document.body).textContent ?? '';
    expect(steps).toContain('phone.example.com knows where this PC is');
    expect(steps).toContain('leads to this PC through your Address book');
  });

  it('an Address book Check that fails says the flat reason, not the Direct one', async () => {
    const t = threeWay(stable('linked', { link_mode: 'domain', link_route: 'book', own_domain: 'https://phone.example.com', own_domain_verified: false, book: { domain: 'https://phone.example.com', supported: true, has_address: true, link: 'failed', reason: 'worker_too_old' } } as Partial<TunnelStatus>), { ok: false, message: 'x' });
    t.api.checkDomain = async (address: string) => ({ ok: false, url: address, http_status: 404, latency_ms: 2, message: 'That name answers, but it is not your Address book Worker. Deploy the Worker and point the name at it.', reason: 'no_worker' });
    await h.mount(makeApi({ tunnel: t.api }));
    await settle(4);
    expect(q('[data-testid="connect-domain-problem"]')).toBeNull();
    expect(text('[data-testid="connect-book-status-text"]')).toContain('shows another website, not your Address book');
  });

  it('an old saved file with no route shows each link its own route, and a status with a route it does not build is not shown as chosen', async () => {
    const old = threeWay(domainStatus());
    await h.mount(makeApi({ tunnel: old.api }));
    expect(q('[data-testid="connect-link-route"]')!.getAttribute('data-route')).toBe('direct');
    await h.unmount();
    h = harness();
    const odd = threeWay(stable('linked', { link_mode: 'permanent', link_route: 'direct' } as Partial<TunnelStatus>));
    await h.mount(makeApi({ tunnel: odd.api }));
    expect(q('[data-testid="connect-link-route"]')!.getAttribute('data-route')).toBe('book');
    expect(q<HTMLButtonElement>('[data-testid="connect-route-direct"]')!.disabled).toBe(true);
  });

  it('Temporary link shows no route switch at all', async () => {
    const t = threeWay(stable('linked', { link_mode: 'temporary', link_temporary: true } as Partial<TunnelStatus>));
    await h.mount(makeApi({ tunnel: t.api }));
    expect(q('[data-testid="connect-link-mode"]')).not.toBeNull();
    expect(q('[data-testid="connect-link-route-block"]')).toBeNull();
  });

  it('saving the supported pair: Permanent saves Address book, My domain saves Direct', async () => {
    const t = threeWay(domainStatus());
    await h.mount(makeApi({ tunnel: t.api }));
    await click(q('[data-testid="connect-link-permanent"]'));
    await settle(3);
    expect(t.calls.at(-1)).toEqual(['permanent', null]);
    expect(t.routes).toEqual(['book']);
    expect(q('[data-testid="connect-link-route"]')!.getAttribute('data-route')).toBe('book');
    await click(q('[data-testid="connect-link-domain"]'));
    await settle(3);
    expect(t.calls.at(-1)).toEqual(['domain', null]);
    // choosing My domain sends no route: the app keeps its own per-name route
    expect(t.routes).toEqual(['book', null]);
    expect(q('[data-testid="connect-link-route"]')!.getAttribute('data-route')).toBe('direct');
  });

  it('pressing the supported route when no route is saved yet saves that route (and nothing else)', async () => {
    const t = threeWay(stable('linked'));
    await h.mount(makeApi({ tunnel: t.api }));
    await click(q('[data-testid="connect-route-book"]'));
    await settle(3);
    expect(t.calls).toEqual([['permanent', null]]);
    expect(t.routes).toEqual(['book']);
    // once saved, pressing it again does nothing
    await click(q('[data-testid="connect-route-book"]'));
    await settle(2);
    expect(t.routes).toEqual(['book']);
  });
});
