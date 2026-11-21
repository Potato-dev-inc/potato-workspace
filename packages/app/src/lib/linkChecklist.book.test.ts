import { describe, expect, it } from 'vitest';
import { bookStages, domainResultText } from './linkChecklist';
import type { TunnelBookStatus, TunnelStatus } from './tauri-types';

// The key plus its variables, so each line's wording choice is visible without the i18n files.
const t = (key: string, vars?: Record<string, string | number>) => `${key}${vars?.domain ? `|${vars.domain}` : ''}`;
const facts = { domain: 'phone.example.com', status: 'idle' as const, verified: false, result: null, secs: 0 };
const status = (book: TunnelBookStatus | null, extra: Partial<TunnelStatus> = {}) => ({ local_port: 1234, port_problem: null, book, ...extra }) as unknown as TunnelStatus;
const ids = (s: ReturnType<typeof bookStages>) => s.map((x) => `${x.id}:${x.status}`);

describe('Address book live steps (My domain + Address book)', () => {
  it('shows real steps in order and marks only what the app has seen', () => {
    const waiting = bookStages(t as never, status({ domain: 'https://phone.example.com', supported: true, has_address: false, link: 'waiting' }), facts);
    expect(ids(waiting)).toEqual(['server:done', 'address:doing', 'register:waiting', 'ask:waiting']);
    const linked = bookStages(t as never, status({ domain: 'https://phone.example.com', supported: true, has_address: true, link: 'linked' }), { ...facts, verified: true });
    expect(ids(linked)).toEqual(['server:done', 'address:done', 'register:done', 'ask:done']);
  });

  it('a name that has not proven it is the Worker is told nothing, and the line says so', () => {
    const unarmed = bookStages(t as never, status({ domain: 'https://phone.example.com', supported: true, has_address: true, armed: false, link: 'waiting' }), facts);
    expect(unarmed[2]).toMatchObject({ id: 'register', status: 'waiting', text: 'check.book.reg.unarmed|phone.example.com' });
  });

  it('a registration that failed says why, by reason', () => {
    const failed = bookStages(t as never, status({ domain: 'https://phone.example.com', supported: true, has_address: true, link: 'failed', reason: 'secret_mismatch' }), facts);
    expect(failed[2]).toMatchObject({ id: 'register', status: 'failed', text: 'check.book.reg.failed.secret_mismatch|phone.example.com' });
  });

  it('a tunnel with no quick address ends the list with one flat line, and a stopped phone server says so', () => {
    const named = bookStages(t as never, status({ domain: 'https://phone.example.com', supported: false, has_address: false, link: 'waiting' }), facts);
    expect(ids(named)).toEqual(['server:done', 'address:failed']);
    expect(named[1].text).toBe('check.book.noQuick');
    const down = bookStages(t as never, status(null, { local_port: null } as Partial<TunnelStatus>), facts);
    expect(ids(down)).toEqual(['server:failed']);
  });

  it('the Check result line uses the Address book words for its reasons', () => {
    const bad = bookStages(t as never, status({ domain: 'https://phone.example.com', supported: true, has_address: true, link: 'linked' }), { ...facts, status: 'bad', result: { reason: 'not_linked', http_status: 503 } });
    expect(bad[3]).toMatchObject({ id: 'ask', status: 'failed', text: 'check.book.why.not_linked|phone.example.com' });
    for (const reason of ['no_quick_tunnel', 'no_address', 'no_worker', 'not_linked', 'stale', 'tunnel_down', 'over_quota', 'busy'] as const) {
      expect(domainResultText(t as never, reason, null, 'phone.example.com', '')).toContain(`check.book.why.${reason}`);
    }
  });
});

describe('Address book: findings about the name', () => {
  it('has a sentence for every new reason, and dns_taken names the record only when it is known', () => {
    for (const reason of ['is_direct', 'dns_taken', 'other_key', 'unconfigured', 'zone_missing'] as const) {
      expect(domainResultText(t as never, reason, null, 'phone.example.com', '', { dnsType: 'CNAME', dnsTarget: 'x' })).toContain(`check.book.why.${reason}`);
    }
    expect(domainResultText(t as never, 'dns_taken', null, 'phone.example.com', '')).toContain('check.book.why.dns_taken_plain');
  });

  it('fills the place to point it at (or the line carries no empty phrase), and drops the grey line that repeats the finding', () => {
    const unarmed = status({ domain: 'https://phone.example.com', supported: true, has_address: true, armed: false, link: 'waiting' });
    const noWorker = bookStages(t as never, unarmed, { ...facts, status: 'bad', result: { reason: 'no_worker', http_status: 404 } });
    expect(ids(noWorker)).toEqual(['server:done', 'address:done', 'ask:failed']);
    // without a finding about the name the unarmed line stays
    expect(ids(bookStages(t as never, unarmed, facts))).toContain('register:waiting');
    // a reason that carries {local} gets the real local address through the Address book list
    const seen: string[] = [];
    const spy = ((key: string, vars?: Record<string, string | number>) => (seen.push(String(vars?.local ?? '')), key)) as never;
    bookStages(spy, status({ domain: 'https://phone.example.com', supported: true, has_address: true, link: 'linked' }), { ...facts, status: 'bad', result: { reason: 'not_this_pc', http_status: 200 } });
    expect(seen).toContain('http://127.0.0.1:1234');
  });
});


describe('apexOf', () => {
  it('takes the last two labels, three for common two-level public suffixes', async () => {
    const { apexOf } = await import('./linkChecklist');
    expect(apexOf('tmux.example.com')).toBe('example.com');
    expect(apexOf('a.b.example.co.uk')).toBe('example.co.uk');
    expect(apexOf('pc.shop.com.tw')).toBe('shop.com.tw');
    expect(apexOf('example.com.au')).toBe('example.com.au');
    expect(apexOf('example.com')).toBe('example.com');
  });
});
