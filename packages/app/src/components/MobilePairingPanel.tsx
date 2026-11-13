import { errorSentence } from '../lib/sayError';
import { useT } from '../i18n';
import {
  buildPairingInviteUrl,
  DEVICE_CAPS,
  encodePairingQrContent,
  PairingQrPayloadSchema,
  type DeviceCap,
  type PairingSession,
} from '@potato-workspace/shared';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { tauri } from '../lib/tauri';
import {
  DEFAULT_DEV_SERVER_PORT,
  localDevPwaUrl,
  normalizePublicBridgeUrl,
  publicOriginFromBridgeUrl,
  resolvePairingBridgeUrl,
  resolvePwaOriginForQr,
  type PublicBridgeDevInfo,
  isLoopbackOrigin,
} from '../lib/public-bridge-url';
import { watchTunnelDevInfo } from '../lib/load-tunnel-dev-info';
import { originNotice } from '../lib/origin-notice';
import { NumberControl, TextControl } from './settings/controls';
import { Btn, Note } from './settings/settings-ui';

/** Fired on window when paired devices change (a phone paired, Revoke, Revoke all, abilities). */
export const DEVICES_CHANGED_EVENT = 'pm-devices-changed';

/** What a newly paired phone may do. Full control is today's behaviour and the default. */
export const PAIRING_CHOICES: { id: 'full' | 'watch_answer'; label: string; hint: string; caps: readonly DeviceCap[] }[] = [
  {
    id: 'full',
    label: 'Full control',
    hint: 'Watch, answer, use the terminal and start tasks, like sitting at this PC.',
    caps: DEVICE_CAPS,
  },
  {
    id: 'watch_answer',
    label: 'Watch and answer only',
    hint: "See your agents and answer their questions. It can't type or start anything.",
    caps: ['watch', 'answer'],
  },
];

interface Props {
  publicPwaUrl: string;
  devServerPort: number;
  onPublicPwaUrlChange: (value: string) => void;
  onDevServerPortChange: (port: number) => void;
  /** The first-run welcome: no address or port fields, only the choice, the code and the QR. */
  compact?: boolean;
}

/** A typed address becomes its origin when it is saved ("pm.example.com" -> "https://pm.example.com"). */
function normalizePwaUrlText(text: string): string {
  if (!text.trim()) return '';
  return publicOriginFromBridgeUrl(normalizePublicBridgeUrl(text));
}

export function MobilePairingPanel({
  publicPwaUrl,
  devServerPort,
  onPublicPwaUrlChange,
  onDevServerPortChange,
  compact = false,
}: Props) {
  const t = useT();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [devInfo, setDevInfo] = useState<PublicBridgeDevInfo | null>(null);
  const [session, setSession] = useState<PairingSession | null>(null);
  const [choice, setChoice] = useState<(typeof PAIRING_CHOICES)[number]['id']>('full');
  const choiceGroup = useId();
  const [, setPairedCount] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const bridgeUrl = resolvePairingBridgeUrl(devInfo, publicPwaUrl, devServerPort);
  const { origin: pwaOrigin } = resolvePwaOriginForQr(devInfo, publicPwaUrl, devServerPort);
  const localProxyTarget = localDevPwaUrl(devServerPort);
  const tunnelOrigin = devInfo?.tunnelUrl?.replace(/\/+$/, '') ?? null;
  const qrReadyRef = useRef(false);

  // A phone that pairs while this panel is open shows up in the Devices list below.
  const refreshDevices = useCallback(async () => {
    const list = await tauri.listPairedMobileDevices();
    setPairedCount((prev) => {
      if (prev !== null && list.length !== prev) window.dispatchEvent(new Event(DEVICES_CHANGED_EVENT));
      return list.length;
    });
  }, []);

  useEffect(() => {
    void refreshDevices();
    // "Revoke all devices" (a separate row) announces itself so this list does not go stale.
    const onDevicesChanged = () => void refreshDevices();
    window.addEventListener(DEVICES_CHANGED_EVENT, onDevicesChanged);
    const stopWatching = watchTunnelDevInfo(setDevInfo);
    return () => {
      window.removeEventListener(DEVICES_CHANGED_EVENT, onDevicesChanged);
      stopWatching();
    };
  }, [refreshDevices]);

  const refreshPairing = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const caps = PAIRING_CHOICES.find((c) => c.id === choice)?.caps ?? DEVICE_CAPS;
      const next = await tauri.createMobilePairingSession(bridgeUrl, caps);
      const payload = PairingQrPayloadSchema.parse(next.qr_payload);
      setSession(next);
      const qrText = encodePairingQrContent(payload, pwaOrigin);
      if (canvasRef.current) {
        await QRCode.toCanvas(canvasRef.current, qrText, {
          width: 220,
          margin: 2,
          color: { dark: '#e8e8e8', light: '#121212' },
        });
      }
    } catch (e) {
      setErr(errorSentence(e));
    } finally {
      setBusy(false);
    }
  }, [bridgeUrl, pwaOrigin, choice]);

  // A different choice needs a new code: the choice is bound to the code on the PC.
  const prevChoiceRef = useRef(choice);
  useEffect(() => {
    if (prevChoiceRef.current === choice) return;
    prevChoiceRef.current = choice;
    if (qrReadyRef.current) void refreshPairing();
  }, [choice, refreshPairing]);

  // While the code is up, notice the phone that redeems it (the Devices list refreshes).
  useEffect(() => {
    if (!session) return;
    const timer = window.setInterval(() => void refreshDevices().catch(() => undefined), 3000);
    return () => window.clearInterval(timer);
  }, [session, refreshDevices]);

  // Opening this tab never makes a code: a code is a record in the audit log and a live way in, so it
  // is made only by the "Pair a phone" button. If the address the phone would use changes while a code
  // is up, that code points at the old address: drop it and let the person make a new one.
  const shownOriginRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = shownOriginRef.current;
    shownOriginRef.current = pwaOrigin;
    if (prev !== null && prev !== pwaOrigin && qrReadyRef.current && !isLoopbackOrigin(pwaOrigin)) {
      qrReadyRef.current = false;
      setSession(null);
    }
  }, [pwaOrigin]);

  const expiresLabel = session
    ? new Date(session.expires_at * 1000).toLocaleTimeString()
    : '—';

  return (
    <div className="st-row is-block" data-testid="pairing-panel">
      <div className="st-label">
        <span>{t('phone.pair.title')}</span>
        <small>{t('phone.pair.hint')}</small>
      </div>
      <div className="st-body space-y-3">
        <fieldset className="st-choices" data-testid="pairing-choice">
          <legend>{t('phone.choice.legend')}</legend>
          {PAIRING_CHOICES.map((option) => (
            <label key={option.id} className="st-choice" data-selected={choice === option.id ? 'true' : undefined}>
              <input
                type="radio"
                name={choiceGroup}
                value={option.id}
                checked={choice === option.id}
                onChange={() => setChoice(option.id)}
              />
              <span className="st-label">
                <span>{t(`phone.choice.${option.id}.label`)}</span>
                <small>{t(`phone.choice.${option.id}.hint`)}</small>
              </span>
            </label>
          ))}
          <p className="st-note">{t('phone.choice.note')}</p>
        </fieldset>

        {(() => {
          const notice = originNotice(pwaOrigin);
          if (!notice) return null;
          return (
            <p className="text-xs" data-testid="pairing-origin">
              <span className="text-pm-muted">{t('phone.connectTo')} </span>
              <strong className="font-mono break-all">{notice.host}</strong>{' '}
              <button
                type="button"
                className="st-linkbtn"
                data-testid="pairing-origin-copy"
                onClick={() => {
                  try {
                    void navigator.clipboard?.writeText(notice.host);
                  } catch {
                    /* no clipboard here */
                  }
                }}
              >
                {t('settings.copy')}
              </button>
              {notice.warning && <span className="block mt-1 text-pm-muted">{notice.warning}</span>}
            </p>
          );
        })()}
        <div className="flex flex-col sm:flex-row gap-4 items-start">
          <div className="rounded-lg border border-pm-border bg-pm-bg p-2 shrink-0" hidden={!session}>
            <canvas ref={canvasRef} className="block" aria-label={t('phone.qrLabel')} />
          </div>
          {session ? (
            <div className="flex-1 min-w-0 space-y-2 text-xs" data-testid="pairing-code">
              <div>
                <div className="text-[10px] text-pm-muted">{t('phone.code')}</div>
                <code className="text-sm font-mono">{session.pairing_code}</code>
              </div>
              <div className="text-[10px] text-pm-muted">{t('phone.expires', { time: expiresLabel })}</div>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  qrReadyRef.current = true;
                  void refreshPairing();
                }}
                className="px-2 py-1 text-xs rounded border border-pm-border hover:bg-pm-border/40 disabled:opacity-50"
              >
                {busy ? t('phone.refreshing') : t('phone.refreshQr')}
              </button>
            </div>
          ) : (
            <div className="flex-1 min-w-0 space-y-2 text-xs">
              <Btn
                primary
                data-testid="pair-a-phone"
                disabled={busy}
                onClick={() => {
                  qrReadyRef.current = true;
                  void refreshPairing();
                }}
              >
                {busy ? t('phone.making') : t('phone.pair.title')}
              </Btn>
              <div className="text-[10px] text-pm-muted">{t('phone.makesCode')}</div>
            </div>
          )}
        </div>

        {!compact && (
        <details className="st-fold" data-testid="pairing-address">
          <summary>{t('phone.address.summary')}</summary>
        <div>
          <label htmlFor="pairing-public-url" className="block text-[11px] text-pm-muted mb-1">
            {t('phone.address.label')}
          </label>
          <TextControl
            id="pairing-public-url"
            aria-label={t('phone.address.label')}
            type="url"
            mono
            value={publicPwaUrl}
            placeholder={t('phone.address.placeholder')}
            normalize={normalizePwaUrlText}
            onCommit={onPublicPwaUrlChange}
          />
          {tunnelOrigin && publicPwaUrl.trim() && publicPwaUrl.replace(/\/+$/, '') !== tunnelOrigin && (
            <p className="text-[10px] text-pm-muted mb-1">
              {t('phone.address.mustOpen')}{' '}
              <button
                type="button"
                className="underline font-mono"
                onClick={() => onPublicPwaUrlChange(tunnelOrigin)}
              >
                {tunnelOrigin}
              </button>
            </p>
          )}
          {tunnelOrigin && !publicPwaUrl.trim() && (
            <p className="text-[10px] text-pm-muted mb-1">
              {t('phone.address.auto')} <code className="font-mono">{tunnelOrigin}</code>
            </p>
          )}
          <label htmlFor="pairing-dev-port" className="block text-[10px] text-pm-muted mb-1 mt-2">
            {t('phone.port')}
          </label>
          <NumberControl
            id="pairing-dev-port"
            aria-label={t('phone.port')}
            min={1024}
            max={65535}
            value={devServerPort}
            onCommit={onDevServerPortChange}
          />
          <p className="text-[10px] text-pm-muted mt-1">
            {t('phone.address.pointBefore')} <code className="font-mono">{localProxyTarget}</code> {t('phone.address.pointMiddle')}{' '}
            <code className="font-mono">{DEFAULT_DEV_SERVER_PORT}</code>{t('phone.address.pointAfter')}
          </p>
          <p className="text-[10px] text-pm-muted mt-1">
            {t('phone.opens')}{' '}
            <code className="font-mono break-all">
              {session ? buildPairingInviteUrl(pwaOrigin, session.pairing_code) : t('phone.shownOnce')}
            </code>
          </p>
          <p className="text-[10px] text-pm-muted mt-1">
            {t('phone.connectsTo')} <code className="font-mono">{bridgeUrl}</code>
            {devInfo?.tunnelUrl && !publicPwaUrl.trim() && (
              <span> · {t('phone.address.autoNote')}</span>
            )}
          </p>
        </div>
        </details>
        )}

        {err && <Note role="alert">{err}</Note>}

      </div>
    </div>
  );
}
