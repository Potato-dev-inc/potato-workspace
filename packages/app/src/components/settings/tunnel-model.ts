// Pure helpers for the "Public address" section in Settings > Mobile PWA.
import { t } from '../../i18n';
import type { TunnelConfigInput, TunnelConfigView, TunnelMode, TunnelStableStatus, TunnelStatus } from '../../lib/tauri-types';

export interface TunnelDraft {
  mode: TunnelMode;
  hostname: string;
  /** Empty = keep the stored token. */
  token: string;
  url: string;
  /** `stable`: the Worker address. */
  workerUrl?: string;
  /** `stable`: a secret the person typed. Empty = keep the stored one (or make one). */
  secret?: string;
}

export const MODE_LABELS: Record<TunnelMode, string> = {
  quick: 'Automatic (changes on restart)',
  named: 'My Cloudflare tunnel',
  custom: 'My own domain or proxy',
  stable: 'Stable link (your own Cloudflare Worker)',
};

export function draftFromConfig(config: TunnelConfigView | null | undefined): TunnelDraft {
  return {
    mode: config?.mode ?? 'quick',
    hostname: config?.hostname ?? '',
    token: '',
    url: config?.mode === 'stable' ? '' : (config?.url ?? ''),
    workerUrl: config?.mode === 'stable' ? (config.url ?? '') : '',
    secret: '',
  };
}

/** Whether Save makes sense, with the reason shown under the form when it does not. */
export function draftProblem(draft: TunnelDraft, config: TunnelConfigView | null | undefined): string | null {
  if (draft.mode === 'named') {
    if (!draft.hostname.trim()) return t('tunnel.problem.hostname');
    const hasStoredToken = config?.mode === 'named' && config.has_token;
    if (!draft.token.trim() && !hasStoredToken) return t('tunnel.problem.token');
  }
  if (draft.mode === 'custom' && !draft.url.trim()) return t('tunnel.problem.address');
  if (draft.mode === 'stable') {
    if (!(draft.workerUrl ?? '').trim()) return t('tunnel.problem.worker');
    const own = (draft.secret ?? '').trim();
    if (own && own.length < 16) return t('tunnel.problem.secret');
  }
  return null;
}

export function toInput(draft: TunnelDraft): TunnelConfigInput {
  if (draft.mode === 'named') {
    const token = draft.token.trim();
    return { mode: 'named', hostname: draft.hostname.trim(), token: token || null };
  }
  if (draft.mode === 'custom') return { mode: 'custom', url: draft.url.trim() };
  if (draft.mode === 'stable') {
    const own = (draft.secret ?? '').trim();
    return { mode: 'stable', worker_url: (draft.workerUrl ?? '').trim(), secret: own || null, secret_action: 'keep' };
  }
  return { mode: 'quick' };
}

export interface StatusLine {
  tone: 'ok' | 'wait' | 'bad' | 'idle';
  text: string;
}

export function statusLine(status: TunnelStatus | null): StatusLine {
  if (!status) return { tone: 'idle', text: t('tunnel.status.desktopOnly') };
  const overridden = status.mode === 'env' ? ` ${t('tunnel.status.outside')}` : '';
  // Stable link: the phone-facing line is about the Worker, not the automatic address behind it.
  if (status.mode === 'stable' && status.stable && status.state !== 'error') return stableLine(status.stable, status.state);
  switch (status.state) {
    case 'running':
      return { tone: 'ok', text: `${t('tunnel.status.online')}${overridden}` };
    case 'starting':
      return { tone: 'wait', text: t('tunnel.status.starting') };
    case 'error':
      return { tone: 'bad', text: status.error ?? t('tunnel.status.stopped') };
    default:
      return { tone: status.error ? 'bad' : 'idle', text: status.error ?? t('tunnel.status.notRunning') };
  }
}

export function isStableMode(mode: TunnelStatus['mode'] | undefined): boolean {
  return mode === 'named' || mode === 'custom' || mode === 'env' || mode === 'stable';
}

/** "Stable link: <worker> → linked / not linked yet (<why>)". */
function stableLine(stable: TunnelStableStatus, state: TunnelStatus['state']): StatusLine {
  const worker = stable.worker_url;
  switch (stable.link) {
    case 'linked':
      return { tone: 'ok', text: t('tunnel.stable.linked', { worker }) };
    case 'failed':
      return {
        tone: 'bad',
        text: stable.error ? t('tunnel.stable.failed', { worker, reason: stable.error }) : t('tunnel.stable.failedNoReason', { worker }),
      };
    case 'linking':
      return { tone: 'wait', text: t('tunnel.stable.linking', { worker }) };
    default:
      return { tone: state === 'starting' ? 'wait' : 'idle', text: t('tunnel.stable.waiting', { worker }) };
  }
}
