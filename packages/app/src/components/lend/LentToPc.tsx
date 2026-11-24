// Connect, on a PC's row: "Uses your sign-ins from this PC · Stop". Stop takes the lend back now (the far chats on it stop working).
import { useState } from 'react';
import { useT } from '../../i18n';
import { errText, isActiveOut, lendApi, type LendApi } from '../../lib/lend';
import type { LendHandle } from './useLend';

export function LentToPc({ node, name, lend, api = lendApi }: { node: string; name: string; lend: LendHandle; api?: LendApi }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const grants = lend.state?.grants.filter((g) => isActiveOut(g, lend.now) && g.peer_node === node) ?? [];
  if (grants.length === 0) return null;
  const stop = async () => {
    setBusy(true);
    setError(null);
    try {
      for (const g of grants) await api.revoke(g.id);
      lend.refresh();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="cx-sub" data-testid={`connect-lent-${node}`}>
      <span>{t('myAgents.connect.uses')}</span>
      {' · '}
      <button type="button" className="cx-link" disabled={busy} title={t('myAgents.connect.stopTip', { name })} data-testid={`connect-lent-stop-${node}`} onClick={() => void stop()}>
        {t('myAgents.connect.stop')}
      </button>
      {error && (
        <span className="cx-error" role="alert">
          {' '}
          {error}
        </span>
      )}
    </div>
  );
}
