// "This PC": the first row of Connect > Devices. It answers one question: can my phone and my other PCs reach this PC?
//   not set up   one orange button, "Make it work anywhere" (the one-click setup; the link's name is made for you)
//   working      "Works anywhere", the link and a Copy button
//   broken       one sentence and one button: "Fix it" (a restart that never tries again before Cloudflare's wait is over),
//                or "Set up again" when a restart cannot help
// The page checks by itself (when it opens and every minute); there is no "Check now". `useThisPc` is shared with the thin
// "This PC can't be reached right now" line that Team and Lending show, so all three always agree.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useT } from '../../i18n';
import type { MessageKey } from '../../i18n/en';
import { oneRelay } from '../../lib/relay';
import type { TunnelBookStatus, TunnelConnectionTest, TunnelEvent, TunnelStatus } from '../../lib/tauri-types';
import { bookStages, domainResultText, domainStages, relayStages, rowIcon, stageIcon, type IconKind, type Stage } from '../../lib/linkChecklist';
import type { UpdateApi } from '../../lib/workerUpdate';
import { verdictFor, workerCheck, type WorkerHealth } from '../../lib/worker';
import type { TunnelApi } from '../settings/TunnelSection';
import { OwnDomainSheet } from './OwnDomain';
import { en } from '../../i18n/en';
import { BookSetup } from './BookSetup';
import { RelaySetupSheet } from './RelaySetup';

/** One tick a second: every tick while the link is coming up (so the step line is live), every 5th when broken, every 60th when settled. */
const POLL_MS = 1000;
/** When the link is up, ask it again only now and then (a minute): that is the automatic "check now". */
const IDLE_EVERY = 60;
const BROKEN_EVERY = 5;
// A fresh address is often not reachable for a few seconds: re-check a bad outside check this many times before the slow cadence.
const OUTSIDE_RETRIES = 6;
/** After this long on the same wait the row says it is still working (only when nothing has failed). */
const STILL_WORKING_SECS = 45;
/** After this many presses of Fix it the row stops offering it and offers "Set up again". */
export const FIX_TRIES = 3;

/** Which link phones are given: the Worker, the plain quick address, or the person's own web address. */
export type LinkMode = 'permanent' | 'temporary' | 'domain';
/** How the chosen link carries traffic: `book` (the address only says where this PC is) or `direct` (the address carries it). */
export type LinkRoute = 'book' | 'direct';
/** Only these link + route pairs exist today: the Worker link with the Address book, and My domain with either route. The others show as "Coming" and are never saved. */
export const routeBuilt = (mode: LinkMode, route: LinkRoute): boolean => (mode === 'permanent' ? route === 'book' : mode === 'domain');
/** The route a link uses when nothing is saved (today's behaviour for each link). */
const defaultRoute = (mode: LinkMode): LinkRoute => (mode === 'domain' ? 'direct' : 'book');
/** What the own address last said when asked: not asked yet, asking, reaches this PC, or does not (yet). */
export type DomainStatus = 'idle' | 'checking' | 'ok' | 'bad';
const hostOf = (url: string) => url.replace(/^https?:\/\//, '');

export type ThisPcState = 'none' | 'setting-up' | 'working' | 'starting' | 'broken';
/** What the broken row can offer: a restart, a fresh setup, or nothing (it retries once Cloudflare's wait is over). */
export type ThisPcFix = 'fix' | 'again' | 'wait' | 'none';

export interface ThisPcProps {
  tunnel: TunnelApi;
  updateApi?: UpdateApi;
  /** PC to PC through the web is on, so a link that lacks that feature gets the one "Update" button. */
  pcsOn?: boolean;
  /** Asks the link what it can do; default is the real check. */
  healthApi?: (address: string) => Promise<WorkerHealth | null>;
}

export interface ThisPcHandle {
  state: ThisPcState;
  host: string;
  fix: ThisPcFix;
  /** The live checklist lines (empty when there is nothing to list). */
  stages: Stage[];
  /** The last real events, oldest first. */
  events: TunnelEvent[];
  /** While getting ready: what the app is doing right now, with a ticking seconds counter ("Getting ready…" when it says nothing). */
  stepText: string;
  /** The wait has gone on for a while and nothing has failed: a small "still working" line. */
  stillWorking: boolean;
  /** Temporary link: the saved relay is not answering. Only a small note, never the row's state. */
  relayNote: string;
  /** There is an address to copy (in Temporary mode: the quick address is ready). */
  canCopy: boolean;
  /** The relay ran out of its free daily limit: the row offers the temporary link. */
  offerTemporary: boolean;
  /** The one plain sentence for a broken state (the wait, the limit, the fresh setup, or the plain "can't reach"). */
  problem: string;
  busy: boolean;
  copied: boolean;
  needsUpdate: boolean;
  /** "Temporary link" is on: phones get the plain quick address and the Worker is left out. */
  temporary: boolean;
  /** Which of the three links is on. */
  mode: LinkMode;
  /** The own address that is saved (kept while another link is on), or null. */
  domain: string | null;
  /** "My domain" can be offered (the app can save it). */
  canDomain: boolean;
  domainStatus: DomainStatus;
  domainMessage: string;
  /** The own address passed a Check, so phones are given it (until then phones keep the other link). */
  domainVerified: boolean;
  /** There is a Worker, so "Permanent link" can be chosen. */
  hasWorker: boolean;
  /** The Worker is linked, so the switch can be shown (there is something to switch back to). */
  canSwitch: boolean;
  /** Set after a switch: phones paired on the other link must pair again. */
  switchedNote: boolean;
  switching: boolean;
  setTemporary: (on: boolean) => void;
  /** Choose a link. "My domain" with no saved address opens the small sheet instead. */
  setMode: (mode: LinkMode) => void;
  /** How the chosen link carries traffic. Only a built pair is shown as selectable. */
  route: LinkRoute;
  routeBuilt: (route: LinkRoute) => boolean;
  /** Save a route for the link on. A route that is not built for it is ignored. */
  setRoute: (route: LinkRoute) => void;
  /** "My domain" + Address book: the registration state with the person's Worker (null for every other link). */
  book: TunnelBookStatus | null;
  /** Copy one of the two Worker files for the person's own Cloudflare. */
  copyBookFile: (which: 'worker' | 'settings') => void;
  /** What the last copy did: the file that was copied, or `failed`. */
  bookCopy: 'worker' | 'settings' | 'failed' | null;
  /** The own address's last Check: why it did not pass (the name's own problems have fixed reason codes), and the record that holds the name. */
  domainReason: string | null;
  domainRecord: { type: string; target: string } | null;
  /** The one plain line for the name's state (what the row and the checklist say). */
  domainLine: string;
  /** A Check is running right now. */
  domainAsking: boolean;
  /** Run the Check now (the Address book panel's button). */
  checkNow: () => void;
  /** The name already goes straight to this PC: switch this domain to Direct and Check. */
  useDirect: () => void;
  /** Restart the tunnel (the Address book says this PC's tunnel is not answering). */
  restartTunnel: () => void;
  /** The Address book panel is open on purpose (Edit), even when the name works. */
  bookOpen: boolean;
  openBook: () => void;
  closeBook: () => void;
  /** Open the sheet to type or change the own address. */
  editDomain: () => void;
  startSetup: () => void;
  press: () => void;
  copy: () => void;
  /** The setup sheet, drawn by whoever shows the row (it must outlive the row's own state changes). */
  sheet: ReactNode;
}

export function useThisPc({ tunnel, updateApi, pcsOn = false, healthApi = workerCheck }: ThisPcProps): ThisPcHandle {
  const t = useT();
  const [status, setStatus] = useState<TunnelStatus | null>(null);
  const [tries, setTries] = useState(0);
  const [statusAt, setStatusAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const settled = useRef(false);
  const fast = useRef(true);
  const [unreachable, setUnreachable] = useState(false);
  const [outside, setOutside] = useState<'idle' | 'doing' | 'ok' | 'bad'>('idle');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [setup, setSetup] = useState(false);
  const [tick, setTick] = useState(0);
  const [pairUpdate, setPairUpdate] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [switchedNote, setSwitchedNote] = useState(false);
  const [domainSheet, setDomainSheet] = useState(false);
  const [domainStatus, setDomainStatus] = useState<DomainStatus>('idle');
  const [domainMessage, setDomainMessage] = useState('');
  const [domainResult, setDomainResult] = useState<{ reason: TunnelConnectionTest['reason']; http_status: number | null; dns_type?: string | null; dns_target?: string | null } | null>(null);
  const [domainAsking, setDomainAsking] = useState(false);
  const [bookOpen, setBookOpen] = useState(false);
  const askRef = useRef<() => void>(() => undefined);
  const [domainSince, setDomainSince] = useState(0);
  const [bookCopy, setBookCopy] = useState<'worker' | 'settings' | 'failed' | null>(null);
  const viaDomain = useRef(false);
  const linked = useRef(false);
  const badTries = useRef(0);
  const outsideBad = useRef(false);
  const alive = useRef(true);
  const relay = oneRelay(status);
  const relayAddress = relay?.address ?? null;
  const relayLinked = relay?.link === 'linked';
  const savedMode: LinkMode = status?.link_mode ?? (status?.link_temporary === true ? 'temporary' : 'permanent');
  // With no Worker there is no permanent link: the plain address is what phones get, so that is what the switch shows.
  const mode: LinkMode = savedMode === 'permanent' && relay === null && status !== null ? 'temporary' : savedMode;
  // Temporary link: phones use the plain address and the relay is not needed, so a dead relay must not decide the row.
  const tempRelay = relay !== null && mode === 'temporary';
  const quickUrl = status?.stable?.quick_url ?? null;
  linked.current = relayLinked && !tempRelay;
  const domain = status?.own_domain ?? null;
  const verified = status?.own_domain_verified === true;
  viaDomain.current = mode === 'domain' && domain !== null;
  // A saved route is shown only when this app builds it for the link on; otherwise the link's own default is shown.
  const savedRoute: LinkRoute = status?.link_route ?? defaultRoute(mode);
  const route: LinkRoute = routeBuilt(mode, savedRoute) ? savedRoute : defaultRoute(mode);
  // Only while My domain is on with the Address book (the panel and its Check belong to that pair).
  const onBook = mode === 'domain' && route === 'book' && domain !== null;
  // Working again: the next trouble gets a fresh set of Fix it presses.
  useEffect(() => {
    if (relayLinked) setTries(0);
  }, [relayLinked]);

  const load = useCallback(() => {
    void Promise.resolve()
      .then(() => tunnel.getStatus())
      .then((s) => {
        if (!alive.current) return;
        setStatus(s);
        setStatusAt(Date.now());
      })
      .catch(() => undefined);
  }, [tunnel]);
  /** The automatic check: a real round trip, so a link that is "ready" on paper but cannot be reached shows as broken. */
  const check = useCallback(() => {
    // With "My domain" the Worker is not what phones use, so its health does not turn the row red.
    if (!linked.current || viaDomain.current) return;
    // A row that is already ok or bad keeps its state while re-checking (no flicker).
    setOutside((o) => (o === 'idle' ? 'doing' : o));
    void Promise.resolve()
      .then(() => tunnel.test())
      .then((r) => {
        if (!alive.current) return;
        outsideBad.current = !r.ok;
        if (r.ok) badTries.current = 0;
        setUnreachable(!r.ok);
        setOutside(r.ok ? 'ok' : 'bad');
      })
      .catch(() => alive.current && ((outsideBad.current = true), setUnreachable(true), setOutside('bad')));
  }, [tunnel]);

  useEffect(() => {
    alive.current = true;
    load();
    let n = 0;
    const id = window.setInterval(() => {
      n += 1;
      if (fast.current || (!settled.current && n % BROKEN_EVERY === 0) || n % IDLE_EVERY === 0) load();
      if (linked.current && n % IDLE_EVERY === 0) check();
      else if (linked.current && outsideBad.current && badTries.current < OUTSIDE_RETRIES && n % BROKEN_EVERY === 0) (badTries.current += 1, check());
      if (fast.current || n % BROKEN_EVERY === 0) setNow(Date.now());
    }, POLL_MS);
    return () => {
      alive.current = false;
      window.clearInterval(id);
    };
  }, [load, check, tick]);
  // The first check when the page opens and the link first shows as ready.
  useEffect(() => {
    if (relayLinked) check();
  }, [relayLinked, check]);

  useEffect(() => {
    if (!pcsOn || !relayAddress || !relayLinked || tempRelay) {
      setPairUpdate(false);
      return;
    }
    let live = true;
    void Promise.resolve(healthApi(relayAddress))
      .then((h) => live && setPairUpdate(verdictFor(h, 'pair') === 'update'))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [pcsOn, relayAddress, relayLinked, tempRelay, healthApi, tick]);

  // "My domain" is on: ask the address itself now and then (a real round trip), so the row can say if it works.
  useEffect(() => {
    if (!(mode === 'domain' && domain) || typeof tunnel.checkDomain !== 'function') {
      setDomainStatus('idle');
      return;
    }
    let live = true;
    // A new name or route: what the last one said does not apply any more (a Direct pass must not carry into Book).
    setDomainResult(null);
    setDomainStatus('idle');
    const ask = () => {
      setDomainStatus((d) => (d === 'ok' ? d : 'checking'));
      setDomainSince(Date.now());
      setDomainAsking(true);
      void Promise.resolve()
        .then(() => tunnel.checkDomain?.(domain))
        .then((r) => {
          if (!live || !r) return;
          // "Goes straight to this PC" is a finding about the name, never a pass for the Address book, whatever `ok` says.
          const passed = r.ok && r.reason !== 'is_direct';
          setDomainStatus(passed ? 'ok' : 'bad');
          setDomainMessage(r.message);
          // Fields this app does not know yet are ignored; the ones it reads are read defensively.
          const more = r as { dns_type?: unknown; dns_target?: unknown };
          setDomainResult({
            reason: r.reason ?? (r.ok ? 'reached' : 'unreachable'),
            http_status: r.http_status ?? null,
            dns_type: typeof more.dns_type === 'string' ? more.dns_type : null,
            dns_target: typeof more.dns_target === 'string' ? more.dns_target : null,
          });
          // A pass is recorded by the app itself: read the setting again so the row sees it.
          if (r.ok) load();
        })
        .catch(() => live && setDomainStatus('bad'))
        .finally(() => live && setDomainAsking(false));
    };
    askRef.current = ask;
    ask();
    const id = window.setInterval(ask, POLL_MS * IDLE_EVERY);
    return () => {
      live = false;
      askRef.current = () => undefined;
      window.clearInterval(id);
    };
  }, [mode, domain, route, tunnel, load]);

  const saveDomain = async (url: string) => {
    if (!tunnel.setLinkMode) return;
    const s = await tunnel.setLinkMode('domain', url);
    if (!alive.current) return;
    setStatus(s);
    setStatusAt(Date.now());
    setSwitchedNote(true);
    setDomainStatus('idle');
    setDomainSheet(false);
  };

  const savePort = async (port: number | null) => {
    const s = await tunnel.setPhonePort?.(port);
    if (!alive.current || !s) return;
    setStatus(s);
    setStatusAt(Date.now());
  };

  const fix = async () => {
    setBusy(true);
    setTries((n) => n + 1);
    try {
      // Never "try anyway": Cloudflare's own wait is respected, so a press can not make it worse.
      const s = await tunnel.restart();
      setUnreachable(false);
      if (alive.current) {
        setStatus(s);
        setStatusAt(Date.now());
        setNow(Date.now());
      }
    } catch {
      /* it stays broken */
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const sheet = setup && (
    <RelaySetupSheet
      api={tunnel}
      updateApi={updateApi}
      onStatus={setStatus}
      onClose={() => {
        setSetup(false);
        setUnreachable(false);
        setTick((n) => n + 1);
      }}
    />
  );

  // Temporary: the row follows the quick address (and the tunnel program), not the relay.
  const stepCode = status?.step?.code;
  const tempReady = quickUrl !== null && status?.state === 'running' && (stepCode === undefined || stepCode === 'connected' || stepCode === 'not_reached');
  // A dev build that never starts the tunnel: say so instead of waiting for ever.
  const tunnelOff = stepCode === 'tunnel_off';
  const broken = relay !== null && !viaDomain.current && (tunnelOff || (tempRelay ? status?.state === 'error' : relay.link === 'failed' || unreachable));
  const reason = !tempRelay && relay?.link === 'failed' ? (status?.stable?.reason ?? null) : null;
  const mismatch = relay?.link === 'failed' && (status?.stable?.secret_mismatch === true || reason === 'secret_mismatch');
  // Cloudflare asked to wait: say how long, and keep the button off until then. The backend sends no wait time once
  // the wait is over (the problem word can stay): then there is no wait.
  const backoff = status && (status.problem === 'too_soon' || status.problem === 'rate_limited') ? status : null;
  const waitMs = backoff && backoff.retry_in_secs ? Math.max(0, backoff.retry_in_secs * 1000 - Math.max(0, now - statusAt)) : 0;
  const waitMinutes = Math.max(1, Math.ceil(waitMs / 60_000));

  const domainSheetEl = domainSheet && (
    <OwnDomainSheet
      initial={domain ?? ''}
      localPort={status?.local_port ?? null}
      chosenPort={status?.chosen_port ?? null}
      onSavePort={typeof tunnel.setPhonePort === 'function' ? savePort : undefined}
      check={typeof tunnel.checkDomain === 'function' ? tunnel.checkDomain : undefined}
      onSave={saveDomain}
      onClose={() => setDomainSheet(false)}
    />
  );
  // With My domain the row follows only that name's pass. The Permanent relay (kept for later) never decides it.
  let state: ThisPcState = 'none';
  if (viaDomain.current && !(setup && relay === null)) state = verified ? 'working' : 'starting';
  else if (relay) state = broken ? 'broken' : (tempRelay && !viaDomain.current ? tempReady : relay.link === 'linked') ? 'working' : 'starting';
  else if (setup) state = 'setting-up';

  let fixKind: ThisPcFix = 'fix';
  let problem = t('connect.thisPc.broken');
  if (tunnelOff) {
    fixKind = 'none';
    problem = t('connect.thisPc.tunnelOff');
  } else if (reason === 'worker_too_old') {
    // The relay Worker is an old version: only a fresh setup (Set up again) replaces it.
    fixKind = 'again';
    problem = t('connect.thisPc.tooOld');
  } else if (mismatch) {
    fixKind = 'again';
    problem = t('connect.thisPc.again');
  } else if (reason === 'worker_gone') {
    // The relay no longer exists: a restart cannot bring it back, only a fresh setup can.
    fixKind = 'again';
    problem = t('connect.thisPc.gone');
  } else if (reason === 'over_quota') {
    fixKind = 'none';
    const reset = new Date(Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate() + 1));
    problem = t('connect.thisPc.quota', { time: reset.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) });
  } else if (reason === 'offline') {
    fixKind = 'none';
    problem = t('connect.thisPc.offline');
  } else if (waitMs > 0) {
    fixKind = 'wait';
    problem = backoff?.problem === 'rate_limited' ? t('connect.thisPc.limited', { minutes: waitMinutes }) : t('connect.thisPc.wait', { minutes: waitMinutes });
  } else if (tries >= FIX_TRIES && !tempRelay) {
    fixKind = 'again';
    problem = t('connect.thisPc.again');
  }

  // What the app is doing right now, with a counter that keeps ticking between two reads of the status.
  const step = status?.step ?? null;
  const stepSecs = step ? step.elapsed_secs + Math.max(0, Math.floor((now - statusAt) / 1000)) : 0;
  // Never a bare "Getting ready": say what is really going on, or why nothing has started.
  const local = status?.local_port ? `http://127.0.0.1:${status.local_port}` : '';
  const domainSecs = Math.max(0, Math.floor((now - domainSince) / 1000));
  let stepText = t('connect.thisPc.nothingWait');
  // The name's one line. Address book findings about the name get their own sentences; a plain Direct miss keeps the short one.
  const bookReason = onBook && domainResult && domainResult.reason !== 'reached' ? domainResult.reason : null;
  const domainNote = bookReason ? domainResultText(t, bookReason, domainResult?.http_status, hostOf(domain ?? ''), local, { dnsType: domainResult?.dns_type, dnsTarget: domainResult?.dns_target }) : '';
  let domainLine = '';
  if (viaDomain.current && domain) {
    domainLine =
      domainStatus === 'checking' && !verified
        ? t('connect.thisPc.domainAsk', { domain: hostOf(domain), s: domainSecs })
        : domainStatus === 'bad'
          ? onBook
            ? domainNote || t('connect.domain.notYet')
            : !verified && domainResult && domainResult.reason !== 'unreachable'
              ? domainResultText(t, domainResult.reason, domainResult.http_status, hostOf(domain), local)
              : t('connect.domain.notYet')
          : !verified && domainStatus !== 'ok'
            ? t('connect.domain.notCheckedShort')
            : domainStatus === 'ok'
              ? !verified && !onBook && domainResult
                ? domainResultText(t, domainResult.reason, domainResult.http_status, hostOf(domain), local)
                : onBook
                ? t('check.book.works', { domain: hostOf(domain) })
                : t('connect.domain.works')
              : t('connect.domain.checking');
    stepText = domainLine;
  } else if (step) {
    const withRetry = step.code === 'registering' && step.retry ? '.retry' : '';
    stepText = t(`connect.step.${step.code}${withRetry}` as MessageKey, { s: stepSecs, retry: step.retry ?? 0, next: step.next_in_secs ?? 0 });
  } else if (status && !status.local_port) {
    stepText = t('connect.thisPc.nothingServer');
  } else if (status?.state === 'stopped') {
    stepText = t('connect.thisPc.nothingStopped');
  } else if (relay?.link === 'linking') {
    stepText = t('connect.thisPc.telling');
  } else if (relay?.link === 'waiting' && status?.state === 'running') {
    stepText = t('connect.thisPc.waitAddr');
  }
  const stages: Stage[] =
    state === 'none' || state === 'setting-up' || status === null
      ? []
      : viaDomain.current && domain
        ? (route === 'book' ? bookStages : domainStages)(t, status, { domain: hostOf(domain), status: domainStatus, verified, result: domainResult, secs: domainSecs })
        : relayStages(t, status, { relayHost: relay?.host ?? null, temporary: tempRelay, reason: status?.stable?.reason ?? null, link: status?.stable?.link ?? 'waiting', stepSecs, outside });
  const stillWorking = state === 'starting' && step !== null && stepSecs >= STILL_WORKING_SECS && status?.state !== 'error' && !status?.problem;
  const relayNote =
    tempRelay && !viaDomain.current && relay?.link === 'failed'
      ? status?.stable?.reason === 'worker_gone'
        ? t('connect.thisPc.noteGone')
        : status?.stable?.reason === 'over_quota'
          ? t('connect.thisPc.noteQuota')
          : t('connect.thisPc.noteOther')
      : '';
  settled.current = state === 'working';
  // An own name that has not passed is asked on its own timer; it never makes the page poll every second.
  fast.current = (state === 'starting' && !viaDomain.current) || state === 'setting-up';

  /** One switch for all three links. It never touches the saved Worker or the saved address. */
  const choose = (next: LinkMode) => {
    if (switching || mode === next || (next === 'permanent' && relay === null)) return;
    if (next === 'domain' && !domain) {
      setDomainSheet(true);
      return;
    }
    // Only a route this app builds for the link is ever sent (Temporary has no route switch: the app keeps its own).
    // My domain sends no route: the app keeps its own route per name (Address book or Direct) and restores it.
    const routeToSave = next === 'temporary' ? null : next === 'domain' ? null : defaultRoute(next);
    const call = tunnel.setLinkMode
      ? () => tunnel.setLinkMode?.(next, null, routeToSave)
      : next === 'domain'
        ? undefined
        : () => tunnel.setTemporary?.(next === 'temporary');
    if (!call) return;
    runSwitch(call);
  };

  /** Save the route for the link on. Only a built pair is sent; the switch is never a no-op for a route not yet saved. */
  const chooseRoute = (next: LinkRoute) => {
    if (switching || !tunnel.setLinkMode || !routeBuilt(mode, next) || status?.link_route === next) return;
    runSwitch(() => tunnel.setLinkMode?.(mode, null, next));
  };

  const runSwitch = (call: () => Promise<TunnelStatus> | undefined) => {
    setSwitching(true);
    void Promise.resolve()
      .then(() => call())
      .then((s) => {
        if (!alive.current || !s) return;
        setStatus(s);
        setStatusAt(Date.now());
        setSwitchedNote(true);
      })
      .catch(() => undefined)
      .finally(() => alive.current && setSwitching(false));
  };

  return {
    state,
    // An address that has not passed Check is not shown as the way in: the chip (and Copy) give where to point it instead.
    host: viaDomain.current && domain ? (verified ? hostOf(domain) : (status?.local_port ? `127.0.0.1:${status.local_port}` : '')) : tempRelay ? (quickUrl ? hostOf(quickUrl) : '') : (relay?.host ?? ''),
    fix: fixKind,
    problem,
    stepText,
    stages,
    events: status?.events ?? [],
    stillWorking,
    relayNote,
    offerTemporary: reason === 'over_quota' && !busy,
    canCopy: !(tempRelay && !viaDomain.current && !quickUrl),
    busy,
    copied,
    needsUpdate: pairUpdate && !broken && mode !== 'domain',
    temporary: status?.link_temporary === true,
    mode,
    domain,
    canDomain: typeof tunnel.setLinkMode === 'function',
    domainStatus,
    domainMessage,
    domainVerified: verified,
    hasWorker: relay !== null,
    canSwitch: status !== null && (typeof tunnel.setTemporary === 'function' || typeof tunnel.setLinkMode === 'function'),
    switchedNote,
    switching,
    setTemporary: (on: boolean) => choose(on ? 'temporary' : 'permanent'),
    setMode: (next: LinkMode) => choose(next),
    route,
    routeBuilt: (r: LinkRoute) => routeBuilt(mode, r),
    setRoute: chooseRoute,
    book: mode === 'domain' && route === 'book' ? (status?.book ?? null) : null,
    bookCopy,
    copyBookFile: (which: 'worker' | 'settings') => {
      if (!domain || typeof tunnel.domainBookFiles !== 'function') return;
      void Promise.resolve(tunnel.domainBookFiles(domain))
        .then((files) => navigator.clipboard.writeText(which === 'worker' ? files.worker_js : files.wrangler_toml))
        .then(
          () => alive.current && setBookCopy(which),
          () => alive.current && setBookCopy('failed'),
        );
    },
    domainReason: domainResult?.reason ?? null,
    domainRecord: domainResult?.dns_type && domainResult.dns_target ? { type: domainResult.dns_type, target: domainResult.dns_target } : null,
    domainLine,
    domainAsking,
    checkNow: () => askRef.current(),
    useDirect: () => {
      if (switching || !tunnel.setLinkMode) return;
      setSwitching(true);
      void Promise.resolve()
        .then(() => tunnel.setLinkMode?.('domain', null, 'direct'))
        .then((s) => {
          if (!alive.current || !s) return;
          setStatus(s);
          setStatusAt(Date.now());
          setBookOpen(false);
          setDomainResult(null);
          setDomainStatus('idle');
          // The route is saved: the check effect re-runs on the route change and asks the name again with Direct.
        })
        .catch(() => undefined)
        .finally(() => alive.current && setSwitching(false));
    },
    restartTunnel: () => void fix(),
    bookOpen,
    openBook: () => setBookOpen(true),
    closeBook: () => setBookOpen(false),
    editDomain: () => setDomainSheet(true),
    startSetup: () => setSetup(true),
    press: () => (fixKind === 'again' ? setSetup(true) : void fix()),
    copy: () => {
      // An address that has not passed Check is not handed out: Copy gives the instruction (where to point it) instead.
      const unproven = viaDomain.current && !verified;
      const address = unproven ? (status?.local_port ? `http://127.0.0.1:${status.local_port}` : null) : viaDomain.current && domain ? domain : tempRelay ? quickUrl : relay?.address;
      if (!address) return;
      try {
        void navigator.clipboard?.writeText(address).then(() => setCopied(true), () => undefined);
      } catch {
        /* no clipboard here */
      }
    },
    sheet: (
      <>
        {sheet}
        {domainSheetEl}
      </>
    ),
  };
}

/** A status mark: a spinner only while busy; a check, a warning mark or a cross once a state is final. */
export function StatusIcon({ kind, testid }: { kind: IconKind; testid?: string }) {
  if (kind === 'busy') return <span className="cx-dot busy" data-icon="busy" data-spinner="true" data-testid={testid} aria-hidden="true" />;
  if (kind === 'idle') return <span className="cx-dot" data-icon="idle" data-testid={testid} aria-hidden="true" />;
  const path = kind === 'ok' ? 'M3 8.5l3.2 3.2L13 5' : kind === 'bad' ? 'M4 4l8 8M12 4l-8 8' : 'M8 3.5v5.5M8 11.6v.9';
  return (
    <span className={`cx-ico ${kind}`} data-icon={kind} data-testid={testid} aria-hidden="true">
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d={path} />
      </svg>
    </span>
  );
}

/** The "This PC" row. `name` is this PC's own name (or a plain "This PC" while it is not known). */
export function ThisPcRow({ pc, name }: { pc: ThisPcHandle; name: string }) {
  const t = useT();
  const [steps, setSteps] = useState(false);
  const [details, setDetails] = useState(false);
  const viaDomain = pc.mode === 'domain' && !!pc.domain;
  const onBook = viaDomain && pc.route === 'book';
  // The Address book panel: open while the name is not working yet, or on purpose (Edit) once it is.
  const bookPanel = onBook && (!(pc.domainVerified && pc.domainStatus !== 'bad') || pc.bookOpen);
  // `relay:` lines belong to the Permanent link only; the Address book's own lines belong to My domain.
  const events = pc.events.filter((e) => (e.code === 'relay_linked' || e.code === 'relay_failed' ? pc.mode === 'permanent' : e.code === 'book_linked' || e.code === 'book_failed' ? onBook : true));
  const dot = rowIcon({ state: pc.state, busy: pc.busy, viaDomain, domainVerified: pc.domainVerified, domainStatus: pc.domainStatus, needsUpdate: pc.needsUpdate });
  const sub =
    pc.state === 'none'
      ? t('connect.thisPc.none')
      : pc.state === 'setting-up'
        ? t('connect.thisPc.settingUp')
        : pc.state === 'starting'
          ? pc.stepText
          : pc.state === 'broken'
            ? pc.busy
              ? t('connect.thisPc.fixing')
              : pc.problem
            : pc.mode === 'domain' && pc.domain
              ? pc.domainLine
              : pc.needsUpdate
                ? t('connect.thisPc.worksUpdate')
                : t('connect.thisPc.works');
  return (
    <section className="cx-group cx-first" data-testid="connect-relay" data-state={pc.state} aria-label={t('connect.thisPc.title')}>
      <div className="cx-ghead">
        <h2>{t('connect.thisPc.title')}</h2>
      </div>
      <div className="cx-row">
        <StatusIcon kind={dot} testid="connect-row-icon" />
        <div className="cx-main">
          <div className="cx-name" data-testid="connect-this-name">
            {name}
          </div>
          <div className={`cx-sub${pc.state === 'working' && !(pc.mode === 'domain' && !(pc.domainVerified && pc.domainStatus === 'ok')) ? ' is-strong' : ''}`} role={pc.state === 'broken' ? 'alert' : undefined} data-testid={pc.state === 'broken' ? 'connect-relay-problem-text' : 'connect-relay-status'}>
            {sub}
          </div>
          {pc.state === 'none' && <div className="cx-note">{t('connect.thisPc.noneNote')}</div>}
          {pc.state === 'starting' && pc.stillWorking && (
            <div className="cx-note" role="status" data-testid="connect-relay-still">
              {t('connect.thisPc.still')}
            </div>
          )}
          {pc.relayNote && pc.state !== 'broken' && (
            <div className="cx-note" role="status" data-testid="connect-relay-note">
              {pc.relayNote}
            </div>
          )}
        </div>
        <div className="cx-act">
          {pc.state === 'none' && (
            <button type="button" className="cx-btn cx-primary" data-testid="relay-set-up" onClick={pc.startSetup}>
              {t('connect.thisPc.set')}
            </button>
          )}
          {(pc.state === 'working' || (viaDomain && pc.state === 'starting')) && (
            <>
              {pc.needsUpdate && (
                <button type="button" className="cx-btn" data-testid="connect-relay-pair-update-go" onClick={pc.startSetup}>
                  {t('connect.thisPc.updateGo')}
                </button>
              )}
              <code className="cx-link-text" data-testid="connect-relay-host">
                {pc.host}
              </code>
              <button type="button" className="cx-btn" data-testid="relay-menu-copy" disabled={!pc.canCopy} onClick={pc.copy}>
                {pc.copied ? t('connect.thisPc.copied') : t('connect.thisPc.copy')}
              </button>
            </>
          )}
          {pc.state === 'broken' && pc.offerTemporary && (
            <button type="button" className="cx-btn cx-primary" data-testid="connect-relay-use-temp" onClick={() => pc.setMode('temporary')}>
              {t('connect.thisPc.useTemp')}
            </button>
          )}
          {pc.state === 'broken' && pc.fix !== 'wait' && pc.fix !== 'none' && (
            <button type="button" className="cx-btn cx-primary" data-testid={pc.fix === 'again' ? 'connect-relay-again' : 'connect-relay-fix'} disabled={pc.busy} onClick={pc.press}>
              {pc.busy ? t('connect.thisPc.fixing') : pc.fix === 'again' ? t('connect.thisPc.againGo') : t('connect.thisPc.fix')}
            </button>
          )}
          {pc.state === 'broken' && pc.fix === 'wait' && (
            <button type="button" className="cx-btn" data-testid="connect-relay-fix" disabled>
              {t('connect.thisPc.fix')}
            </button>
          )}
        </div>
      </div>
      {pc.stages.length > 0 && (
        <div className="cx-row cx-row-wide" data-testid="connect-steps">
          <div className="cx-main">
            {(pc.state !== 'working' || steps) && (
              <ol className="cx-steps" aria-live="polite">
                {pc.stages.map((s) => (
                  <li key={s.id} className="cx-step" data-step={s.id} data-status={s.status}>
                    <StatusIcon kind={stageIcon(s.status)} />
                    <span>{s.status === 'doing' && s.secs !== undefined ? `${s.text}… ${s.secs} s` : s.text}</span>
                  </li>
                ))}
              </ol>
            )}
            {details && (
              <ul className="cx-events" data-testid="connect-events">
                {events.length === 0 && <li>{t('check.none')}</li>}
                {events.map((e, i) => (
                  <li key={`${e.at_ms}-${i}`}>
                    {new Date(e.at_ms).toLocaleTimeString([], { hour12: false })} {eventText(t, e)}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="cx-act">
            {pc.state === 'working' && (
              <button type="button" className="cx-link" data-testid="connect-steps-toggle" onClick={() => setSteps((v) => !v)}>
                {steps ? t('check.hide') : t('check.show')}
              </button>
            )}
            <button type="button" className="cx-link" data-testid="connect-details-toggle" onClick={() => setDetails((v) => !v)}>
              {details ? t('check.detailsHide') : t('check.details')}
            </button>
          </div>
        </div>
      )}
      {pc.canSwitch && (
        <div className="cx-row cx-row-stack" data-testid="connect-link-mode" data-mode={pc.mode} data-temporary={pc.temporary ? 'true' : 'false'}>
          <div className="cx-main">
            <div className="cx-name">{t('connect.link.title')}</div>
            <div className="cx-sub" data-testid="connect-link-note">
              {pc.mode === 'domain' ? (pc.route === 'book' ? t('connect.link.bookNote') : t('connect.link.domainNote')) : pc.mode === 'temporary' ? t('connect.link.tempNote') : t('connect.link.permNote')}
            </div>
            {bookPanel && <BookSetup pc={pc} />}
            {pc.mode === 'domain' && pc.domain && !pc.domainVerified && pc.domainStatus !== 'ok' && !bookPanel && (
              <div className="cx-note" role="status" data-testid="connect-domain-unchecked">
                {t('connect.domain.notChecked')}
              </div>
            )}
            {pc.switchedNote && (
              <div className="cx-note" role="status" data-testid="connect-link-repair">
                {t('connect.link.repair')}
              </div>
            )}
          </div>
          <div className="cx-act">
            <div className="cx-seg" role="radiogroup" aria-label={t('connect.link.title')}>
              <button type="button" role="radio" aria-checked={pc.mode === 'permanent'} disabled={pc.switching || !pc.hasWorker} data-testid="connect-link-permanent" onClick={() => pc.setMode('permanent')}>
                {t('connect.link.permanent')}
              </button>
              <button type="button" role="radio" aria-checked={pc.mode === 'temporary'} disabled={pc.switching} data-testid="connect-link-temporary" onClick={() => pc.setMode('temporary')}>
                {t('connect.link.temporary')}
              </button>
              {pc.canDomain && (
                <button type="button" role="radio" aria-checked={pc.mode === 'domain'} disabled={pc.switching} data-testid="connect-link-domain" onClick={() => pc.setMode('domain')}>
                  {t('connect.link.domain')}
                </button>
              )}
            </div>
            {pc.mode !== 'temporary' && (
              <div className="cx-route" data-testid="connect-link-route-block">
                <div className="cx-seg" role="radiogroup" aria-label={t('connect.route.title')} data-testid="connect-link-route" data-route={pc.route}>
                  <button type="button" role="radio" aria-checked={pc.route === 'book'} disabled={pc.switching || !pc.routeBuilt('book')} data-testid="connect-route-book" onClick={() => pc.setRoute('book')}>
                    {t('connect.route.book')}
                    {!pc.routeBuilt('book') && <small> {t('connect.route.coming')}</small>}
                  </button>
                  <button type="button" role="radio" aria-checked={pc.route === 'direct'} disabled={pc.switching || !pc.routeBuilt('direct')} data-testid="connect-route-direct" onClick={() => pc.setRoute('direct')}>
                    {t('connect.route.direct')}
                    {!pc.routeBuilt('direct') && <small> {t('connect.route.coming')}</small>}
                  </button>
                </div>
                <div className="cx-sub" data-testid="connect-route-note">
                  {pc.route === 'book' ? t('connect.route.bookNote') : t('connect.route.directNote')}
                </div>
              </div>
            )}
            {pc.canDomain && pc.domain && (
              <button type="button" className="cx-btn" data-testid="connect-link-domain-edit" onClick={onBook ? pc.openBook : pc.editDomain}>
                {t('connect.link.domainEdit')}
              </button>
            )}
          </div>
        </div>
      )}
      {pc.sheet}
    </section>
  );
}

function eventText(t: ReturnType<typeof useT>, e: TunnelEvent): string {
  // A reason this app has no words for is shown as a plain "could not", never as a raw key.
  // The name already goes straight to this PC: a finding about the name, worded on its own (an older app never sends it).
  if (e.code === 'book_failed' && e.reason === 'is_direct' && 'check.ev.book_direct' in en) return t('check.ev.book_direct', { host: e.host ?? '' });
  const key = e.code === 'book_failed' && e.reason === 'worker_too_old' ? 'check.why.book_worker_too_old' : `check.why.${e.reason}`;
  const why = e.reason ? (key in en ? t(key as MessageKey) : t('check.why.book_unknown')) : '';
  if (!(`check.ev.${e.code}` in en)) return '';
  return t(`check.ev.${e.code}` as MessageKey, { host: e.host ?? '', why });
}

/** The thin line Team and Lending show only while this PC cannot be reached. Nothing at all when all is well. It says the true reason (`pc.problem`: the wait, the limit, the old relay, the relay that is gone), not one generic sentence. */
export function ReachLine({ pc }: { pc: ThisPcHandle }) {
  const t = useT();
  if (pc.state !== 'broken') return null;
  return (
    <div className="cx-thin" role="status" data-testid="connect-reach">
      <span className="cx-dot warn" aria-hidden="true" />
      <span>{pc.busy ? t('connect.thisPc.fixing') : pc.problem}</span>
      {pc.fix !== 'wait' && pc.fix !== 'none' && (
        <button type="button" className="cx-link cx-strong" data-testid="connect-reach-fix" disabled={pc.busy} onClick={pc.press}>
          {pc.fix === 'again' ? t('connect.thisPc.againGo') : t('connect.thisPc.fix')}
        </button>
      )}
    </div>
  );
}
