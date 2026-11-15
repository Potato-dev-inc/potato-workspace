// The "both people confirm" sheet. It shows the same code on both PCs; pairing finishes only when both press Allow.
// Only this window can answer it (no agent, MCP tool or phone route reaches the command).
import { useState } from 'react';
import { useT } from '../../i18n';
import { devicesApi, type DevicesApi, type PendingPair } from '../../lib/devices';
import '../../styles/devices.css';

export function PairConfirm({ pending, api = devicesApi }: { pending: PendingPair; api?: DevicesApi }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const answer = (allow: boolean) => {
    setBusy(true);
    api
      .pairAnswer(pending.id, allow)
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };
  return (
    <div className="dev-scrim dev-scrim--top" data-testid="pair-confirm">
      <div className="dev-sheet" role="alertdialog" aria-label={t('devices.title')}>
        <h2>{t('devices.confirm', { name: pending.name, code: pending.code })}</h2>
        <p className="dev-note">{t('devices.confirmHelp')}</p>
        <div className="dev-code" aria-label={t('devices.codeLabel')}>
          {pending.code}
        </div>
        <div className="dev-actions">
          <button type="button" className="dev-btn" disabled={busy} onClick={() => answer(false)} data-testid="pair-no">
            {t('devices.no')}
          </button>
          <button type="button" className="dev-btn is-primary" disabled={busy} onClick={() => answer(true)} data-testid="pair-allow">
            {t('devices.allow')}
          </button>
        </div>
      </div>
    </div>
  );
}
