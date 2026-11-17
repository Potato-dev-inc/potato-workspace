// Connect > Phone, the default view: it should feel like pairing headphones. One line, one code, one status line.
// The app makes every technical choice: it starts the quick address by itself, uses the fixed one when it is set up,
// falls back to the quick one when the fixed one fails, and offers the fixed one only after something really hurt.
// Nothing here asks for a choice, an account or a password. The technical controls live in "Advanced" (ConnectPage).
import { buildPairingInviteUrl, encodePairingQrContent, PairingQrPayloadSchema, type PairingSession } from '@potato-workspace/shared';
import QRCode from 'qrcode';
import { useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n';
import { firstScanWorked, markFirstScan, offerSnoozed } from '../../lib/connect-offer';
import { watchTunnelDevInfo } from '../../lib/load-tunnel-dev-info';
import { resolvePhoneAddress } from '../../lib/phone-address';
import { isLoopbackOrigin, parseDevServerPort, type PublicBridgeDevInfo } from '../../lib/public-bridge-url';
import { errorSentence } from '../../lib/sayError';
import { tauri } from '../../lib/tauri';
import type { TunnelStatus } from '../../lib/tauri-types';
import { problemText } from '../settings/tunnel-model';
import type { TunnelApi } from '../settings/TunnelSection';
import { StableOffer } from './StableOffer';
import { useTunnelStatus } from './useTunnelStatus';

/** After this many "Fix it" presses the page stops retrying and asks the agent instead. */
export const FIX_TRIES = 3;
/** A code is renewed a little before it runs out, so a scan never meets an expired one. */
const RENEW_EARLY_MS = 20_000;
/** setTimeout cannot wait longer than this (a larger delay fires at once). */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** The automatic code lets a phone watch, answer and send messages (`type`); "control" stays one tap per phone in Advanced. */
export const AUTO_CAPS = ['watch', 'answer', 'type'] as const;

export interface SimplePhoneProps {
  tunnel: TunnelApi;
  /** How many phones are paired right now (null while it is being read). */
  phones: number | null;
  /** The saved address typed in Advanced (usually empty) and the phone server's port. */
  publicPwaUrl: string;
  devServerPort: unknown;
  /** The settings are loaded: a code is made only after that. */
  ready: boolean;
  /** The Advanced pairing panel is open: it keeps the one pending code, so this view makes none and hides its own. */
  paused?: boolean;
}

/** True while this window is visible and not blurred (codes are made and renewed only then). */
function useLooking(): [boolean, (v: boolean) => void] {
  const [on, setOn] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  useEffect(() => {
    const sync = () => setOn(document.visibilityState !== 'hidden');
    const off = () => setOn(false);
    const back = () => setOn(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('blur', off);
    window.addEventListener('focus', back);
    return () => {
      document.removeEventListener('visibilitychange', sync);
      window.removeEventListener('blur', off);
      window.removeEventListener('focus', back);
    };
  }, []);
  return [on, setOn];
}

export function SimplePhone({ tunnel, phones, publicPwaUrl, devServerPort, ready, paused = false }: SimplePhoneProps) {
  const t = useT();
  const [looking, setLooking] = useLooking();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useTunnelStatus(tunnel);
  const [devInfo, setDevInfo] = useState<PublicBridgeDevInfo | null>(null);
  const [session, setSession] = useState<PairingSession | null>(null);
  const [origin, setOrigin] = useState('');
  const [codeErr, setCodeErr] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [copied, setCopied] = useState(false);
  const [rescan, setRescan] = useState(false);
  const [gone, setGone] = useState(false);
  const [tries, setTries] = useState(0);
  const [fixing, setFixing] = useState(false);
  const [fixErr, setFixErr] = useState<string | null>(null);

  useEffect(() => watchTunnelDevInfo(setDevInfo), []);

  // First use: start the quick address without asking, once. (The app usually has done it already.)
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !status) return;
    started.current = true;
    if (status.mode === 'quick' && status.state === 'stopped' && !status.problem) {
      void Promise.resolve()
        .then(() => tunnel.restart())
        .then(setStatus, () => undefined);
    }
  }, [status, tunnel, setStatus]);

  const port = parseDevServerPort(devServerPort);
  const primary = resolvePhoneAddress(devInfo, publicPwaUrl, port, status);
  // The fixed address failed: use the quick one for now (never a code that would open "your PC is offline").
  const fallback = primary.blocked ? resolvePhoneAddress(devInfo, publicPwaUrl, port, null) : null;
  const temporary = fallback !== null && fallback.source === 'tunnel' && !isLoopbackOrigin(fallback.origin);
  const addr = temporary && fallback ? fallback : primary;
  const reachable = !isLoopbackOrigin(addr.origin) && (addr.blocked === null || temporary);
  const linkWaiting = primary.blocked !== null && !temporary && status?.stable?.link !== 'failed' && status?.state !== 'error';
  const tunnelBad = status?.state === 'error';
  const problem = ready && (tunnelBad || codeErr !== null || (primary.blocked !== null && !temporary && !linkWaiting));
  const waiting = !problem && !reachable;

  // Make (and renew) the code while the address is usable. Opening this tab is the "Pair a phone" press here.
  const key = ready && reachable && !problem && !paused && looking ? `${addr.origin}|${addr.bridgeUrl}|${nonce}` : null;
  useEffect(() => {
    if (!key) {
      setSession(null);
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const next = await tauri.createMobilePairingSession(addr.bridgeUrl, AUTO_CAPS);
        const payload = PairingQrPayloadSchema.parse(next.qr_payload);
        const text = encodePairingQrContent(payload, addr.origin);
        if (canvasRef.current) {
          // A phone camera reads dark on light best, so the code is always black on white, in both themes.
          await QRCode.toCanvas(canvasRef.current, text, { width: 280, margin: 2, color: { dark: '#000000', light: '#ffffff' } });
        }
        if (!alive) return;
        setOrigin(addr.origin);
        setSession(next);
        setCodeErr(null);
      } catch (e) {
        if (alive) setCodeErr(errorSentence(e));
      }
    })();
    return () => {
      alive = false;
    };
    // The address pieces are inside `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => {
    if (!session) return;
    const wait = Math.min(MAX_TIMER_MS, Math.max(5_000, session.expires_at * 1000 - Date.now() - RENEW_EARLY_MS));
    const id = window.setTimeout(() => setNonce((n) => n + 1), wait);
    return () => window.clearTimeout(id);
  }, [session]);

  // A phone that connected: remember that the first scan worked (the offer may show from now on).
  const count = phones ?? 0;
  useEffect(() => {
    if (count > 0) markFirstScan();
  }, [count]);
  // A phone paired: that code is spent, so make a new one (a second phone can scan it).
  const lastCount = useRef<number | null>(null);
  useEffect(() => {
    if (phones === null) return;
    if (lastCount.current !== null && phones > lastCount.current) setNonce((n) => n + 1);
    lastCount.current = phones;
  }, [phones]);
  // The quick address changed while it was in use: the phone drops, so say "Scan again." (the code renews by itself).
  const lastOrigin = useRef<string | null>(null);
  const countAtChange = useRef(0);
  useEffect(() => {
    if (!reachable) return;
    const prev = lastOrigin.current;
    lastOrigin.current = addr.origin;
    if (prev !== null && prev !== addr.origin && addr.source === 'tunnel' && (count > 0 || firstScanWorked())) {
      countAtChange.current = count;
      setRescan(true);
    }
  }, [reachable, addr.origin, addr.source, count]);
  useEffect(() => {
    if (rescan && count !== countAtChange.current) setRescan(false);
  }, [count, rescan]);
  useEffect(() => {
    if (!problem) {
      setTries(0);
      setFixErr(null);
    }
  }, [problem]);

  const fixIt = async () => {
    setFixing(true);
    setFixErr(null);
    setTries((n) => n + 1);
    try {
      setStatus(await tunnel.restart());
      setCodeErr(null);
      setNonce((n) => n + 1);
    } catch (e) {
      setFixErr(errorSentence(e));
    } finally {
      setFixing(false);
    }
  };

  const copyLink = () => {
    if (!session) return;
    try {
      void navigator.clipboard?.writeText(buildPairingInviteUrl(origin, session.pairing_code)).then(() => setCopied(true), () => undefined);
    } catch {
      /* no clipboard here */
    }
  };

  const hasFixed = status?.mode === 'stable' && Boolean(status.stable);
  const showOffer = !gone && rescan && !hasFixed && firstScanWorked() && !offerSnoozed();

  const line =
    phones === null || !ready
      ? '…'
      : problem
        ? t('connect.simple.problem')
        : rescan
          ? t('connect.simple.scanAgain')
          : waiting
            ? t('connect.simple.starting')
            : count > 0
              ? t('connect.simple.connected')
              : t('connect.simple.ready');
  const back = backoffLine(status, t);
  const details = [status?.error, primary.blocked && !temporary ? primary.blocked.reason : null, codeErr, fixErr, status && status.problem ? problemText(status) : null].filter(
    (s, i, a): s is string => Boolean(s) && a.indexOf(s) === i,
  );

  return (
    <div className="cn-simple" data-testid="connect-simple" data-state={problem ? 'problem' : waiting ? 'starting' : rescan ? 'rescan' : count > 0 ? 'connected' : 'ready'}>
      {!problem && (
        <p className="cn-simple-lead" data-testid="connect-simple-lead">
          {t('connect.simple.lead')}
        </p>
      )}
      <div className="cn-qr" hidden={!session || problem || paused || !looking}>
        <canvas ref={canvasRef} className="cn-qr-canvas" aria-label={t('connect.simple.qrAria')} data-testid="connect-qr" />
      </div>
      {!problem && paused && (
        <p className="cn-simple-note" data-testid="connect-simple-paused">
          {t('connect.simple.paused')}
        </p>
      )}
      {!problem && !paused && !looking && reachable && (
        <button type="button" className="cn-qr cn-qr-away" data-testid="connect-qr-away" onClick={() => setLooking(true)}>
          {t('connect.simple.show')}
        </button>
      )}
      {session && !problem && !paused && looking && (
        <p className="cn-simple-note" data-testid="connect-simple-caps">
          {t('connect.simple.caps')}
        </p>
      )}
      <p className="cn-simple-status" role="status" data-testid="connect-simple-status">
        <span className="cn-dot" aria-hidden="true" data-on={!problem && count > 0 && !rescan ? 'true' : 'false'} />
        {line}
      </p>
      {temporary && !problem && (
        <p className="cn-simple-note" data-testid="connect-simple-temp">
          {t('connect.simple.temp')}
        </p>
      )}
      {session && !problem && !paused && looking && (
        <button type="button" className="ck-btn" data-testid="connect-copy-link" onClick={copyLink}>
          {copied ? t('connect.simple.copied') : t('connect.simple.copyLink')}
        </button>
      )}
      {problem && (
        <div className="cn-problem" data-testid="connect-problem">
          {tries < FIX_TRIES ? (
            <button type="button" className="ck-btn ck-btn--primary" data-testid="connect-fix" disabled={fixing} onClick={() => void fixIt()}>
              {fixing ? t('connect.simple.fixing') : t('connect.simple.fix')}
            </button>
          ) : (
            <p data-testid="connect-ask-agent">{t('connect.simple.askAgent')}</p>
          )}
          {back && (
            <p className="cn-simple-note" data-testid="connect-backoff">
              {back}
            </p>
          )}
          <details className="cn-problem-details" data-testid="connect-problem-details">
            <summary>{t('connect.simple.details')}</summary>
            {details.length > 0 ? (
              details.map((d) => (
                <p key={d} className="cn-detail-line">
                  {d}
                </p>
              ))
            ) : (
              <p className="cn-detail-line">{t('connect.simple.noDetails')}</p>
            )}
          </details>
        </div>
      )}
      {showOffer && <StableOffer tunnel={tunnel} status={status ?? null} onStatus={setStatus} onGone={() => setGone(true)} />}
    </div>
  );
}

/** The plain wait time after a restart was refused (the technical sentence is in "Show details"). */
function backoffLine(status: TunnelStatus | null | undefined, t: ReturnType<typeof useT>): string | null {
  if (!status || !status.problem || status.state !== 'error') return null;
  if (status.problem === 'too_soon') return t('connect.simple.retryIn', { minutes: Math.max(1, Math.ceil((status.retry_in_secs ?? 120) / 60)) });
  if (status.problem === 'rate_limited') return t('connect.simple.limited');
  return t('connect.simple.slow');
}
