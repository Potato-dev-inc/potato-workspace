// The "both people confirm" sheet. Two modes:
// - `code` (default): both PCs show the same code; pairing finishes only when both press Allow.
// - `check`: the sheet offers three numbers; the person taps the one both screens show. No Allow button.
// Only this window can answer it (no agent, MCP tool or phone route reaches the command).
import { useState } from 'react';
import { useT } from '../../i18n';
import { devicesApi, type DevicesApi, type PendingPair } from '../../lib/devices';
import '../../styles/devices.css';

/** "012345" shows as "012 345". */
const spaced = (digits: string) => (digits.length === 6 ? `${digits.slice(0, 3)} ${digits.slice(3)}` : digits);

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
  const pick = (digits: string) => {
    setBusy(true);
    api
      .pairPick(pending.id, digits)
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };
  if (pending.mode === 'check') {
    return (
      <div className="dev-scrim dev-scrim--top" data-testid="pair-confirm">
        <div className="dev-sheet" role="alertdialog" aria-label={t('devices.title')}>
          <h2>{t('devices.check.title', { name: pending.name })}</h2>
          {pending.fingerprint && (
            <p className="dev-note">
              {t('devices.check.fingerprint')} <span data-testid="pair-fingerprint">{pending.fingerprint}</span>
            </p>
          )}
          <p className="dev-note">{t('devices.check.help')}</p>
          <p className="dev-note">{t('devices.check.pickHelp')}</p>
          <p className="dev-note" data-testid="pair-none-hint">{t('devices.check.none')}</p>
          <div className="dev-picks">
            {(pending.choices ?? []).map((digits) => (
              <button key={digits} type="button" className="dev-pick" disabled={busy} onClick={() => pick(digits)} data-testid={`pair-pick-${digits}`}>
                {spaced(digits)}
              </button>
            ))}
          </div>
          <div className="dev-actions">
            <button type="button" className="dev-btn" disabled={busy} onClick={() => answer(false)} data-testid="pair-no">
              {t('devices.no')}
            </button>
          </div>
        </div>
      </div>
    );
  }
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
