// The live checklist under the This PC row: plain lines, each with a real state. Built only from data the app really has
// (the tunnel status, its step, the own-address Check). A line is "done" only when the data says it completed; nothing is invented.
import type { MessageKey } from '../i18n/en';
import type { TunnelStatus, TunnelConnectionTest } from './tauri-types';

export type StageStatus = 'done' | 'doing' | 'waiting' | 'failed' | 'warning';

/** The icon a status shows: only 'busy' spins (a step really in progress); every other status is a still icon. */
export type IconKind = 'ok' | 'warn' | 'bad' | 'busy' | 'idle';
export const stageIcon = (s: StageStatus): IconKind => (s === 'done' ? 'ok' : s === 'doing' ? 'busy' : s === 'failed' ? 'bad' : s === 'warning' ? 'warn' : 'idle');

export interface RowFacts {
  state: 'none' | 'setting-up' | 'starting' | 'working' | 'broken';
  busy: boolean;
  viaDomain: boolean;
  domainVerified: boolean;
  domainStatus: 'idle' | 'checking' | 'ok' | 'bad';
  needsUpdate: boolean;
}
/** The icon of the This PC row. It spins only while something is really in progress (starting, setting up, fixing, checking); a reached, warned or failed state is still. */
export function rowIcon(f: RowFacts): IconKind {
  if (f.viaDomain && f.state !== 'setting-up') {
    if (f.domainStatus === 'ok') return 'ok';
    if (f.domainStatus === 'bad') return 'warn';
    if (f.domainStatus === 'checking') return 'busy';
    return f.domainVerified ? 'ok' : 'idle';
  }
  if (f.state === 'working') return f.needsUpdate ? 'warn' : 'ok';
  if (f.state === 'broken') return f.busy ? 'busy' : 'warn';
  if (f.state === 'setting-up' || f.state === 'starting' || f.busy) return 'busy';
  return 'idle';
}
export interface Stage {
  id: string;
  text: string;
  status: StageStatus;
  /** Seconds this line has been going (only the line being done now). */
  secs?: number;
}
type T = (key: MessageKey, vars?: Record<string, string | number>) => string;

const ORDER = ['starting_phone_server', 'starting_tunnel', 'waiting_for_address', 'address_ready', 'registering', 'checking_outside', 'connected'];
const at = (code: string | undefined) => (code ? ORDER.indexOf(code) : -1);

export interface DomainFacts {
  domain: string;
  status: 'idle' | 'checking' | 'ok' | 'bad';
  verified: boolean;
  result: Pick<TunnelConnectionTest, 'reason' | 'http_status' | 'dns_type' | 'dns_target'> | null;
  secs: number;
}

/** What the Check says about the NAME itself (not about this PC): these are fixed in the Address book panel, not by restarting. */
export const NAME_PROBLEMS = ['no_worker', 'is_direct', 'other_key', 'unconfigured', 'dns_taken', 'zone_missing'] as const;
export const isNameProblem = (reason: string | null | undefined): boolean => (NAME_PROBLEMS as readonly string[]).includes(reason ?? '');
/** The name's zone, as far as it can be told from the name: the last two labels (a hint for the sentence, never sent anywhere). */
const TWO_LEVEL_SUFFIXES = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'com.tw', 'org.tw', 'net.tw', 'idv.tw', 'com.au', 'net.au', 'org.au', 'co.jp', 'or.jp', 'ne.jp', 'co.nz', 'co.kr', 'com.cn', 'com.hk', 'com.sg', 'com.br', 'co.in', 'co.za']);
export const apexOf = (domain: string): string => {
  const labels = domain.split('.');
  // A small built-in list of common two-level public suffixes, so "a.b.co.uk" gives "b.co.uk" (a hint only; not the full public suffix list).
  return labels.slice(TWO_LEVEL_SUFFIXES.has(labels.slice(-2).join('.')) ? -3 : -2).join('.');
};

/** The sentence for what the own-address Check found. `extra` carries the record that holds the name, when the backend names it. */
export function domainResultText(t: T, reason: string | null | undefined, http: number | null | undefined, domain: string, local: string, extra?: { dnsType?: string | null; dnsTarget?: string | null }): string {
  const vars = { domain, code: http ?? 0, local, apex: apexOf(domain), type: extra?.dnsType ?? '', target: extra?.dnsTarget ?? '' };
  if (reason === 'dns_taken' && !(extra?.dnsType && extra?.dnsTarget)) return t('check.book.why.dns_taken_plain', vars);
  switch (reason) {
    case 'reached':
      return t('check.domain.reached', vars);
    case 'not_this_pc':
      return t('check.domain.notThisPc', vars);
    case 'bad_gateway':
      return t('check.domain.badGateway', vars);
    case 'redirect':
      return t('check.domain.redirect', vars);
    case 'other_http':
      return t('check.domain.otherHttp', vars);
    case 'dns':
      return t('check.domain.dns', vars);
    case 'timeout':
      return t('check.domain.timeout', vars);
    // Address book (the name is a small Worker that holds this PC's address)
    case 'no_quick_tunnel':
    case 'no_address':
    case 'no_worker':
    case 'not_linked':
    case 'stale':
    case 'tunnel_down':
    case 'over_quota':
    case 'busy':
    case 'is_direct':
    case 'dns_taken':
    case 'other_key':
    case 'unconfigured':
    case 'zone_missing':
      return t(`check.book.why.${reason}` as MessageKey, vars);
    default:
      return t('check.domain.unreachable', vars);
  }
}

export function domainStages(t: T, status: TunnelStatus | null, f: DomainFacts): Stage[] {
  const local = status?.local_port ? `http://127.0.0.1:${status.local_port}` : '';
  const out: Stage[] = [];
  const serverDown = !status?.local_port || status.port_problem === 'not_running';
  out.push({ id: 'server', text: serverDown ? t('check.server.down') : t('check.server.up'), status: serverDown ? 'failed' : 'done' });
  if (serverDown) {
    out.push({ id: 'ask', text: t('check.domain.ask', { domain: f.domain }), status: 'waiting' });
    return out;
  }
  if (f.status === 'checking' && !f.result) {
    out.push({ id: 'ask', text: t('check.domain.ask', { domain: f.domain }), status: 'doing', secs: f.secs });
  } else if (f.result) {
    const ok = f.result.reason === 'reached';
    out.push({ id: 'ask', text: domainResultText(t, f.result.reason, f.result.http_status, f.domain, local), status: ok ? 'done' : 'failed' });
  } else if (f.verified) {
    out.push({ id: 'ask', text: t('check.domain.reached', { domain: f.domain, code: 0, local }), status: 'done' });
  } else {
    out.push({ id: 'ask', text: t('check.domain.ask', { domain: f.domain }), status: 'waiting' });
  }
  return out;
}

/**
 * The live lines for "My domain" + Address book. Each is "done" only when the app has really seen it: the phone server answering,
 * a quick address, the Worker told (the backend's own registration state), and a Check that took the phone's path to this PC.
 */
export function bookStages(t: T, status: TunnelStatus | null, f: DomainFacts): Stage[] {
  const out: Stage[] = [];
  const local = status?.local_port ? `http://127.0.0.1:${status.local_port}` : '';
  const nameProblem = isNameProblem(f.result?.reason);
  const book = status?.book ?? null;
  const serverDown = !status?.local_port || status.port_problem === 'not_running';
  out.push({ id: 'server', text: serverDown ? t('check.server.down') : t('check.server.up'), status: serverDown ? 'failed' : 'done' });
  if (serverDown) return out;
  if (book && !book.supported) {
    out.push({ id: 'address', text: t('check.book.noQuick'), status: 'failed' });
    return out;
  }
  const haveAddress = book?.has_address === true;
  out.push({ id: 'address', text: haveAddress ? t('check.address.got') : t('check.address.waiting'), status: haveAddress ? 'done' : 'doing' });
  const link = book?.link ?? 'waiting';
  // The grey "has to answer as your Worker" line says the same as the Check's own finding about the name: leave it out then.
  const sameAsCheck = nameProblem && link !== 'linked' && link !== 'failed' && book?.armed === false;
  if (!sameAsCheck) {
    out.push(
      link === 'linked'
        ? { id: 'register', text: t('check.book.reg.done', { domain: f.domain }), status: 'done' }
        : link === 'failed'
          ? { id: 'register', text: t(`check.book.reg.failed.${book?.reason ?? 'other'}` as MessageKey, { domain: f.domain }), status: book?.reason === 'worker_too_old' ? 'warning' : 'failed' }
          : book?.armed === false
            ? { id: 'register', text: t('check.book.reg.unarmed', { domain: f.domain }), status: 'waiting' }
            : link === 'linking'
              ? { id: 'register', text: t('check.book.reg.doing', { domain: f.domain }), status: 'doing' }
              : { id: 'register', text: t('check.book.reg.waiting', { domain: f.domain }), status: 'waiting' },
    );
  }
  if (f.status === 'checking' && !f.result) {
    out.push({ id: 'ask', text: t('check.book.ask', { domain: f.domain }), status: 'doing', secs: f.secs });
  } else if (f.result) {
    const ok = f.result.reason === 'reached';
    out.push({ id: 'ask', text: ok ? t('check.book.reached', { domain: f.domain }) : domainResultText(t, f.result.reason, f.result.http_status, f.domain, local, { dnsType: f.result.dns_type, dnsTarget: f.result.dns_target }), status: ok ? 'done' : 'failed' });
  } else if (f.verified) {
    out.push({ id: 'ask', text: t('check.book.reached', { domain: f.domain }), status: 'done' });
  } else {
    out.push({ id: 'ask', text: t('check.book.ask', { domain: f.domain }), status: 'waiting' });
  }
  return out;
}

export interface RelayFacts {
  /** The saved relay's host name, or null when none is saved. */
  relayHost: string | null;
  temporary: boolean;
  reason: string | null;
  /** The relay link as the backend reports it. */
  link: 'waiting' | 'linking' | 'linked' | 'failed';
  stepSecs: number;
  /** The automatic round trip to the link: not run yet, running, passed, or failed. */
  outside: 'idle' | 'doing' | 'ok' | 'bad';
}

export function relayStages(t: T, status: TunnelStatus | null, f: RelayFacts): Stage[] {
  const out: Stage[] = [];
  const step = status?.step ?? null;
  const code = step?.code;
  const idx = at(code);
  const secs = f.stepSecs;
  if (code === 'tunnel_off') {
    out.push({ id: 'off', text: t('connect.thisPc.tunnelOff'), status: 'failed' });
    return out;
  }
  const failedProblem = status?.problem === 'rate_limited' || status?.problem === 'slow_start' || status?.problem === 'too_soon';
  if (!f.temporary && f.relayHost) {
    // "Found" only once the relay has really answered (linked, or an answer that names a reason). Not on the saved name alone.
    const answered = f.link === 'linked' || (f.link === 'failed' && f.reason !== 'offline');
    out.push(
      f.reason === 'worker_gone'
        ? { id: 'relay', text: t('check.relay.gone'), status: 'failed' }
        : answered
          ? { id: 'relay', text: t('check.relay.found', { host: f.relayHost }), status: 'done' }
          : { id: 'relay', text: t('check.relay.looking', { host: f.relayHost }), status: f.link === 'linking' ? 'doing' : 'waiting' },
    );
  } else if (f.temporary) {
    out.push({ id: 'relay', text: t('check.relay.temp'), status: 'done' });
  }
  const serverUp = !!status?.local_port;
  out.push({
    id: 'server',
    text: serverUp ? t('check.server.up') : t('check.server.starting'),
    status: serverUp ? 'done' : status?.port_problem === 'not_running' ? 'failed' : code === 'starting_phone_server' ? 'doing' : 'waiting',
    secs: code === 'starting_phone_server' ? secs : undefined,
  });
  const tunnelDone = idx > at('starting_tunnel') || (status?.state === 'running' && idx < 0);
  out.push({
    id: 'tunnel',
    text: tunnelDone ? t('check.tunnel.started') : t('check.tunnel.starting'),
    status: tunnelDone ? 'done' : code === 'starting_tunnel' ? 'doing' : 'waiting',
    secs: code === 'starting_tunnel' ? secs : undefined,
  });
  const haveAddress = idx >= at('address_ready') || (status?.stable?.quick_url ?? null) !== null;
  out.push({
    id: 'address',
    text: haveAddress ? t('check.address.got') : t('check.address.waiting'),
    status: haveAddress ? 'done' : failedProblem ? 'failed' : code === 'waiting_for_address' ? 'doing' : 'waiting',
    secs: code === 'waiting_for_address' ? secs : undefined,
  });
  if (!f.temporary && f.relayHost && f.reason !== 'worker_gone') {
    const failed = f.link === 'failed';
    const tooOld = failed && f.reason === 'worker_too_old';
    out.push({
      id: 'register',
      text: tooOld ? t('check.register.tooOld') : failed ? t('check.register.failed') : f.link === 'linked' ? t('check.register.done') : t('check.register.doing'),
      status: f.link === 'linked' ? 'done' : tooOld ? 'warning' : failed ? 'failed' : code === 'registering' ? 'doing' : 'waiting',
      secs: code === 'registering' ? secs : undefined,
    });
  }
  if (f.temporary) {
    const notReached = code === 'not_reached';
    out.push({
      id: 'outside',
      text: notReached ? t('check.outside.failed') : code === 'connected' ? t('check.outside.done') : t('check.outside.doing'),
      status: code === 'connected' ? 'done' : notReached ? 'failed' : code === 'checking_outside' ? 'doing' : 'waiting',
      secs: code === 'checking_outside' ? secs : undefined,
    });
  }
  if (!f.temporary && f.relayHost && f.reason !== 'worker_gone') {
    out.push({
      id: 'outside',
      text: f.outside === 'bad' ? t('check.outside.failed') : f.outside === 'ok' ? t('check.outside.done') : t('check.outside.doing'),
      status: f.outside === 'ok' ? 'done' : f.outside === 'bad' ? 'failed' : f.outside === 'doing' ? 'doing' : 'waiting',
    });
  }
  const connected = f.temporary ? code === 'connected' : f.link === 'linked';
  out.push({ id: 'connected', text: t('check.connected'), status: connected ? 'done' : 'waiting' });
  return out;
}
