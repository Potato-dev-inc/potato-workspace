// "This PC": the first row of Connect > Devices. It answers one question: can my phone and my other PCs reach this PC?
//   not set up   one orange button, "Make it work anywhere" (the one-click setup; the link's name is made for you)
//   working      "Works anywhere", the link and a Copy button
//   broken       one sentence and one button: "Fix it" (a restart that never tries again before Cloudflare's wait is over),
//                or "Set up again" when a restart cannot help
// The page checks by itself (when it opens and every minute); there is no "Check now". `useThisPc` is shared with the thin
// "This PC can't be reached right now" line that Team and Lending show, so all three always agree.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useT } from '../../i18n';
import { oneRelay } from '../../lib/relay';
import type { TunnelStatus } from '../../lib/tauri-types';
import type { UpdateApi } from '../../lib/workerUpdate';
import { verdictFor, workerCheck, type WorkerHealth } from '../../lib/worker';
import type { TunnelApi } from '../settings/TunnelSection';
import { RelaySetupSheet } from './RelaySetup';

const POLL_MS = 5000;
/** When the link is up, ask it again only now and then (a minute): that is the automatic "check now". */
const IDLE_EVERY = 12;
/** After this many presses of Fix it the row stops offering it and offers "Set up again". */
export const FIX_TRIES = 3;

export type ThisPcState = 'none' | 'setting-up' | 'working' | 'starting' | 'broken';
/** What the broken row can offer: a restart, a fresh setup, or nothing (it retries once Cloudflare's wait is over). */
export type ThisPcFix = 'fix' | 'again' | 'wait';

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
  /** The one plain sentence for a broken state (the wait, the limit, the fresh setup, or the plain "can't reach"). */
  problem: string;
  busy: boolean;
  copied: boolean;
  needsUpdate: boolean;
  /** "Temporary link" is on: phones get the plain quick address and the Worker is left out. */
  temporary: boolean;
  /** The Worker is linked, so the switch can be shown (there is something to switch back to). */
  canSwitch: boolean;
  /** Set after a switch: phones paired on the other link must pair again. */
  switchedNote: boolean;
  switching: boolean;
  setTemporary: (on: boolean) => void;
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
  const [unreachable, setUnreachable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [setup, setSetup] = useState(false);
  const [tick, setTick] = useState(0);
  const [pairUpdate, setPairUpdate] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [switchedNote, setSwitchedNote] = useState(false);
  const linked = useRef(false);
  const alive = useRef(true);
  const relay = oneRelay(status);
  const relayAddress = relay?.address ?? null;
  const relayLinked = relay?.link === 'linked';
  linked.current = relayLinked;
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
    if (!linked.current) return;
    void Promise.resolve()
      .then(() => tunnel.test())
      .then((r) => alive.current && setUnreachable(!r.ok))
      .catch(() => alive.current && setUnreachable(true));
  }, [tunnel]);

  useEffect(() => {
    alive.current = true;
    load();
    let n = 0;
    const id = window.setInterval(() => {
      n += 1;
      if (!linked.current || n % IDLE_EVERY === 0) load();
      if (linked.current && n % IDLE_EVERY === 0) check();
    }, POLL_MS);
    const clock = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => {
      alive.current = false;
      window.clearInterval(id);
      window.clearInterval(clock);
    };
  }, [load, check, tick]);
  // The first check when the page opens and the link first shows as ready.
  useEffect(() => {
    if (relayLinked) check();
  }, [relayLinked, check]);

  useEffect(() => {
    if (!pcsOn || !relayAddress || !relayLinked) {
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
  }, [pcsOn, relayAddress, relayLinked, healthApi, tick]);

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

  const broken = relay !== null && (relay.link === 'failed' || unreachable);
  const mismatch = relay?.link === 'failed' && status?.stable?.secret_mismatch === true;
  // Cloudflare asked to wait: say how long, and keep the button off until then. The backend sends no wait time once
  // the wait is over (the problem word can stay): then there is no wait.
  const backoff = status && (status.problem === 'too_soon' || status.problem === 'rate_limited') ? status : null;
  const waitMs = backoff && backoff.retry_in_secs ? Math.max(0, backoff.retry_in_secs * 1000 - Math.max(0, now - statusAt)) : 0;
  const waitMinutes = Math.max(1, Math.ceil(waitMs / 60_000));

  let state: ThisPcState = 'none';
  if (relay) state = broken ? 'broken' : relay.link === 'linked' ? 'working' : 'starting';
  else if (setup) state = 'setting-up';

  let fixKind: ThisPcFix = 'fix';
  let problem = t('connect.thisPc.broken');
  if (mismatch) {
    fixKind = 'again';
    problem = t('connect.thisPc.again');
  } else if (waitMs > 0) {
    fixKind = 'wait';
    problem = backoff?.problem === 'rate_limited' ? t('connect.thisPc.limited', { minutes: waitMinutes }) : t('connect.thisPc.wait', { minutes: waitMinutes });
  } else if (tries >= FIX_TRIES) {
    fixKind = 'again';
    problem = t('connect.thisPc.again');
  }

  return {
    state,
    host: relay?.host ?? '',
    fix: fixKind,
    problem,
    busy,
    copied,
    needsUpdate: pairUpdate && !broken,
    temporary: status?.link_temporary === true,
    canSwitch: relay !== null && typeof tunnel.setTemporary === 'function',
    switchedNote,
    switching,
    setTemporary: (on: boolean) => {
      if (!tunnel.setTemporary || switching || (status?.link_temporary === true) === on) return;
      setSwitching(true);
      void Promise.resolve()
        .then(() => tunnel.setTemporary?.(on))
        .then((s) => {
          if (!alive.current || !s) return;
          setStatus(s);
          setStatusAt(Date.now());
          setSwitchedNote(true);
        })
        .catch(() => undefined)
        .finally(() => alive.current && setSwitching(false));
    },
    startSetup: () => setSetup(true),
    press: () => (fixKind === 'again' ? setSetup(true) : void fix()),
    copy: () => {
      if (!relay) return;
      try {
        void navigator.clipboard?.writeText(relay.address).then(() => setCopied(true), () => undefined);
      } catch {
        /* no clipboard here */
      }
    },
    sheet,
  };
}

/** The "This PC" row. `name` is this PC's own name (or a plain "This PC" while it is not known). */
export function ThisPcRow({ pc, name }: { pc: ThisPcHandle; name: string }) {
  const t = useT();
  const dot = pc.state === 'working' ? 'ok' : pc.state === 'broken' ? 'warn' : pc.state === 'setting-up' || pc.state === 'starting' || pc.busy ? 'busy' : '';
  const sub =
    pc.state === 'none'
      ? t('connect.thisPc.none')
      : pc.state === 'setting-up'
        ? t('connect.thisPc.settingUp')
        : pc.state === 'starting'
          ? t('connect.thisPc.starting')
          : pc.state === 'broken'
            ? pc.busy
              ? t('connect.thisPc.fixing')
              : pc.problem
            : pc.needsUpdate
              ? t('connect.thisPc.worksUpdate')
              : t('connect.thisPc.works');
  return (
    <section className="cx-group cx-first" data-testid="connect-relay" data-state={pc.state} aria-label={t('connect.thisPc.title')}>
      <div className="cx-ghead">
        <h2>{t('connect.thisPc.title')}</h2>
      </div>
      <div className="cx-row">
        <span className={`cx-dot ${dot}`} aria-hidden="true" />
        <div className="cx-main">
          <div className="cx-name" data-testid="connect-this-name">
            {name}
          </div>
          <div className={`cx-sub${pc.state === 'working' ? ' is-strong' : ''}`} role={pc.state === 'broken' ? 'alert' : undefined} data-testid={pc.state === 'broken' ? 'connect-relay-problem-text' : 'connect-relay-status'}>
            {sub}
          </div>
          {pc.state === 'none' && <div className="cx-note">{t('connect.thisPc.noneNote')}</div>}
        </div>
        <div className="cx-act">
          {pc.state === 'none' && (
            <button type="button" className="cx-btn cx-primary" data-testid="relay-set-up" onClick={pc.startSetup}>
              {t('connect.thisPc.set')}
            </button>
          )}
          {pc.state === 'working' && (
            <>
              {pc.needsUpdate && (
                <button type="button" className="cx-btn" data-testid="connect-relay-pair-update-go" onClick={pc.startSetup}>
                  {t('connect.thisPc.updateGo')}
                </button>
              )}
              <code className="cx-link-text" data-testid="connect-relay-host">
                {pc.host}
              </code>
              <button type="button" className="cx-btn" data-testid="relay-menu-copy" onClick={pc.copy}>
                {pc.copied ? t('connect.thisPc.copied') : t('connect.thisPc.copy')}
              </button>
            </>
          )}
          {pc.state === 'broken' && pc.fix !== 'wait' && (
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
      {pc.canSwitch && (
        <div className="cx-row" data-testid="connect-link-mode" data-temporary={pc.temporary ? 'true' : 'false'}>
          <div className="cx-main">
            <div className="cx-name">{t('connect.link.title')}</div>
            <div className="cx-sub" data-testid="connect-link-note">
              {pc.temporary ? t('connect.link.tempNote') : t('connect.link.permNote')}
            </div>
            {pc.switchedNote && (
              <div className="cx-note" role="status" data-testid="connect-link-repair">
                {t('connect.link.repair')}
              </div>
            )}
          </div>
          <div className="cx-act">
            <div className="cx-seg" role="radiogroup" aria-label={t('connect.link.title')}>
              <button type="button" role="radio" aria-checked={!pc.temporary} disabled={pc.switching} data-testid="connect-link-permanent" onClick={() => pc.setTemporary(false)}>
                {t('connect.link.permanent')}
              </button>
              <button type="button" role="radio" aria-checked={pc.temporary} disabled={pc.switching} data-testid="connect-link-temporary" onClick={() => pc.setTemporary(true)}>
                {t('connect.link.temporary')}
              </button>
            </div>
          </div>
        </div>
      )}
      {pc.sheet}
    </section>
  );
}

/** The thin line Team and Lending show only while this PC cannot be reached. Nothing at all when all is well. */
export function ReachLine({ pc }: { pc: ThisPcHandle }) {
  const t = useT();
  if (pc.state !== 'broken') return null;
  return (
    <div className="cx-thin" role="status" data-testid="connect-reach">
      <span className="cx-dot warn" aria-hidden="true" />
      <span>{pc.busy ? t('connect.thisPc.fixing') : t('connect.reach.line')}</span>
      {pc.fix !== 'wait' && (
        <button type="button" className="cx-link cx-strong" data-testid="connect-reach-fix" disabled={pc.busy} onClick={pc.press}>
          {pc.fix === 'again' ? t('connect.thisPc.againGo') : t('connect.thisPc.fix')}
        </button>
      )}
      {pc.fix === 'wait' && <span className="cx-faint">{pc.problem}</span>}
    </div>
  );
}
