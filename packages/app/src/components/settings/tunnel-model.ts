// Pure helpers for the "Public address" section in Settings > Mobile PWA.
import { t } from '../../i18n';
import type { TunnelConfigInput, TunnelConfigView, TunnelMode, TunnelStatus } from '../../lib/tauri-types';

export interface TunnelDraft {
  mode: TunnelMode;
  hostname: string;
  /** Empty = keep the stored token. */
  token: string;
  url: string;
}

export const MODE_LABELS: Record<TunnelMode, string> = {
  quick: 'Automatic (changes on restart)',
  named: 'My Cloudflare tunnel',
  custom: 'My own domain or proxy',
};

export function draftFromConfig(config: TunnelConfigView | null | undefined): TunnelDraft {
  return {
    mode: config?.mode ?? 'quick',
    hostname: config?.hostname ?? '',
    token: '',
    url: config?.url ?? '',
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
  return null;
}

export function toInput(draft: TunnelDraft): TunnelConfigInput {
  if (draft.mode === 'named') {
    const token = draft.token.trim();
    return { mode: 'named', hostname: draft.hostname.trim(), token: token || null };
  }
  if (draft.mode === 'custom') return { mode: 'custom', url: draft.url.trim() };
  return { mode: 'quick' };
}

export interface StatusLine {
  tone: 'ok' | 'wait' | 'bad' | 'idle';
  text: string;
}

export function statusLine(status: TunnelStatus | null): StatusLine {
  if (!status) return { tone: 'idle', text: t('tunnel.status.desktopOnly') };
  const overridden = status.mode === 'env' ? ` ${t('tunnel.status.outside')}` : '';
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
  return mode === 'named' || mode === 'custom' || mode === 'env';
}
