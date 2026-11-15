// "Your phone will connect to <address>" under Pair a phone, with the way to keep one address (the stable link).
import { useCallback, useEffect, useState } from 'react';
import { useT } from '../i18n';
import { originNotice } from '../lib/origin-notice';
import { tauri } from '../lib/tauri';
import type { TunnelStatus } from '../lib/tauri-types';
import { StableLinkSheet } from './StableLinkSheet';
import type { TunnelApi } from './settings/TunnelSection';

export const defaultTunnelApi: TunnelApi = {
  getStatus: () => tauri.getTunnelStatus(),
  save: (input) => tauri.setTunnelConfig(input),
  restart: () => tauri.restartTunnel(),
  test: () => tauri.testTunnelConnection(),
};

const hostOf = (url: string | null | undefined): string => {
  try {
    return url ? new URL(url).host : '';
  } catch {
    return url ?? '';
  }
};
const isAutomatic = (origin: string) => hostOf(origin).endsWith('.trycloudflare.com');

export function PairingAddress({ pwaOrigin, api = defaultTunnelApi, offer = true }: { pwaOrigin: string; api?: TunnelApi; offer?: boolean }) {
  const t = useT();
  const [status, setStatus] = useState<TunnelStatus | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    void Promise.resolve()
      .then(() => api.getStatus())
      .then((s) => alive && setStatus(s))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [api]);
  const onStatus = useCallback((s: TunnelStatus) => setStatus(s), []);

  const stable = status?.mode === 'stable' && status.stable ? status.stable : null;
  const linked = stable?.link === 'linked';
  // Linked: show the Worker. Otherwise whatever address the phone would be sent to.
  const shownOrigin = linked && stable ? stable.worker_url : pwaOrigin;
  const notice = originNotice(shownOrigin);
  if (!notice) return null;
  const copy = () => {
    try {
      void navigator.clipboard?.writeText(notice.host);
    } catch {
      /* no clipboard here */
    }
  };
  return (
    <div data-testid="pairing-origin-block">
      <p className="text-xs" data-testid="pairing-origin">
        <span className="text-pm-muted">{t('phone.connectTo')} </span>
        <strong className="font-mono break-all">{notice.host}</strong>{' '}
        {linked && (
          <span className="stable-chip" data-testid="stable-chip">
            {t('stable.chip')}
          </span>
        )}{' '}
        <button type="button" className="st-linkbtn" data-testid="pairing-origin-copy" onClick={copy}>
          {t('settings.copy')}
        </button>
        {notice.warning && <span className="block mt-1 text-pm-muted">{notice.warning}</span>}
        {linked && stable?.quick_url && (
          <span className="block mt-1 text-pm-muted" data-testid="pairing-behind">
            {t('stable.behind', { host: hostOf(stable.quick_url) })}
          </span>
        )}
      </p>
      {offer && !linked && isAutomatic(shownOrigin) && (
        <p className="text-xs mt-1" data-testid="stable-offer">
          <span className="text-pm-muted">{t('stable.changes')} </span>
          <button type="button" className="st-linkbtn stable-keep" data-testid="keep-one-address" onClick={() => setOpen(true)}>
            {t('stable.keep')}
          </button>
        </p>
      )}
      {offer && !linked && stable && (
        <p className="text-xs mt-1" data-testid="stable-pending">
          <span className="text-pm-muted">{t('stable.pending')} </span>
          <button type="button" className="st-linkbtn stable-keep" data-testid="stable-fix" onClick={() => setOpen(true)}>
            {t('stable.fix')}
          </button>
        </p>
      )}
      {open && <StableLinkSheet api={api} initial={status} onStatus={onStatus} onClose={() => setOpen(false)} />}
    </div>
  );
}
