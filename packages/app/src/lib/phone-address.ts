// The one place that decides which address a phone is sent to (the QR code, the code's address, the line under it).
// Stable link: the Worker is the phone's address, but only once this PC is linked to it. Until then the Worker would
// answer "your PC is offline" (it does not know where this PC is), so no code is made and the reason is shown instead.
// The automatic address (trycloudflare) is never put in a code while a Worker is chosen: it changes on every restart.
import { t } from '../i18n';
import type { TunnelStatus } from './tauri-types';
import { normalizePublicBridgeUrl, publicOriginFromBridgeUrl, resolvePairingBridgeUrl, resolvePwaOriginForQr, type PublicBridgeDevInfo } from './public-bridge-url';

export interface PhoneStable {
  /** The Worker address, without a trailing slash. */
  worker: string;
  linked: boolean;
  /** A plain sentence for why the Worker cannot be used yet. Empty once linked. */
  reason: string;
}

const trimSlash = (url: string) => url.replace(/\/+$/, '');
const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** The stable link as the phone sees it, or `null` when no Worker is chosen. */
export function phoneStable(status: TunnelStatus | null | undefined): PhoneStable | null {
  if (!status || status.mode !== 'stable' || !status.stable) return null;
  // "Temporary link": the plain quick address is used directly, the Worker is left out.
  if (status.link_temporary) return null;
  const { worker_url: worker, link, error } = status.stable;
  if (link === 'linked' && status.state !== 'error') return { worker: trimSlash(worker), linked: true, reason: '' };
  const reason =
    status.state === 'error' && status.error
      ? status.error
      : link === 'failed'
        ? (error ?? t('phone.notReady.failed'))
        : link === 'linking'
          ? t('phone.notReady.linking')
          : t('phone.notReady.waiting');
  return { worker: trimSlash(worker), linked: false, reason };
}

export interface PhoneAddress {
  /** The page address inside the QR code. */
  origin: string;
  /** The address the phone talks to. */
  bridgeUrl: string;
  source: 'custom' | 'stable' | 'tunnel' | 'local';
  /** Set while a Worker is chosen but this PC is not linked to it: a code must not be made. */
  blocked: PhoneStable | null;
}

export function resolvePhoneAddress(
  devInfo: PublicBridgeDevInfo | null,
  customUrl: string | null,
  devServerPort: number,
  status: TunnelStatus | null | undefined,
): PhoneAddress {
  const stable = phoneStable(status);
  const custom = customUrl?.trim() ? publicOriginFromBridgeUrl(normalizePublicBridgeUrl(customUrl)) : null;
  // A typed address wins, unless it is the Worker itself (then the link state decides).
  if (custom && !(stable && hostOf(custom) === hostOf(stable.worker))) {
    return { origin: custom, bridgeUrl: normalizePublicBridgeUrl(customUrl as string), source: 'custom', blocked: null };
  }
  if (stable) {
    return { origin: stable.worker, bridgeUrl: `${stable.worker}/bridge`, source: 'stable', blocked: stable.linked ? null : stable };
  }
  const { origin, source } = resolvePwaOriginForQr(devInfo, customUrl, devServerPort);
  return { origin, bridgeUrl: resolvePairingBridgeUrl(devInfo, customUrl, devServerPort), source, blocked: null };
}
