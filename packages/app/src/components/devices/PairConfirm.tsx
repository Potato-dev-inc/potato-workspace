// The "both people confirm" sheet. Four modes:
// - `code` (default): both PCs show the same code; pairing finishes only when both press Allow.
// - `check`: the sheet offers three numbers; the person taps the one both screens show. No Allow button.
// - `type` / `show` (a PC of the person's own account, `pending.account`): the PC being opened shows NO number and its person TYPES the six
//   digits that the other PC shows (`show`: big digits, and one button "I typed it"). One chance in a million, not one in three. Both
//   sheets show when the other PC joined the account and its key's fingerprint, warn about a PC that joined moments ago (or at an
//   unknown time), and nothing on the sheet can ask for a right (a pairing through the account always starts with every right off). The knocking PC's name
//   is a small detail, never the title (a name is whatever the other PC says it is). The account is only who each PC says it is.
// Only this window can answer it (no agent, MCP tool or phone route reaches the command).
import { useState } from 'react';
import { getLanguage, useT } from '../../i18n';
import { devicesApi, type DevicesApi, type PendingPair } from '../../lib/devices';
import '../../styles/devices.css';

/** "012345" shows as "012 345". */
const spaced = (digits: string) => (digits.length === 6 ? `${digits.slice(0, 3)} ${digits.slice(3)}` : digits);

export function PairConfirm({ pending, api = devicesApi }: { pending: PendingPair; api?: DevicesApi }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState('');
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
  if (pending.mode === 'type' || pending.mode === 'show') {
    const acct = pending.account ?? null;
    const host = pending.mode === 'type';
    // A PC the account cannot date counts as new.
    const recent = acct === null || acct.first_seen <= 0 || Date.now() / 1000 - acct.first_seen < 24 * 3600;
    const digitsOk = typed.replace(/[\s-]/g, '').length === 6 && /^[0-9 -]+$/.test(typed);
    return (
      <div className="dev-scrim dev-scrim--top" data-testid="pair-confirm" data-account="true" data-mode={pending.mode}>
        <div className="dev-sheet" role="alertdialog" aria-label={t('devices.title')}>
          <h2>{host ? t('account.pair.hostTitle') : t('account.pair.joinTitle', { name: pending.name })}</h2>
          <p className="dev-note">{t(host ? 'account.pair.hostHelp' : 'account.pair.joinHelp', { name: pending.name })}</p>
          <p className="dev-note" data-testid="pair-never">
            <b>{t('account.pair.never')}</b>
          </p>
          {recent && (
            <p className="dev-error" role="alert" data-testid="pair-account-recent">
              {t('account.pair.recent')}
            </p>
          )}
          <p className="dev-note" data-testid="pair-account-added">
            {host && (
              <>
                {t('account.pair.nameDetail', { name: pending.name })}
                {' · '}
              </>
            )}
            {acct && acct.first_seen > 0 ? t('account.pair.added', { date: new Date(acct.first_seen * 1000).toLocaleDateString(getLanguage() === 'zh-TW' ? 'zh-TW' : 'en-GB', { day: 'numeric', month: 'short' }) }) : t('account.pair.addedUnknown')}
            {pending.fingerprint && (
              <>
                {' · '}
                {t('devices.check.fingerprint')} <span data-testid="pair-fingerprint">{pending.fingerprint}</span>
              </>
            )}
          </p>
          {host ? (
            <input
              className="dev-type"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              maxLength={7}
              placeholder="--- ---"
              aria-label={t('account.pair.typeLabel', { name: pending.name })}
              value={typed}
              disabled={busy}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && digitsOk && pick(typed.replace(/[\s-]/g, ''))}
              data-testid="pair-type"
            />
          ) : (
            <div className="dev-code" data-testid="pair-digits" aria-label={t('devices.codeLabel')}>
              {spaced(pending.number ?? '')}
            </div>
          )}
          <div className="dev-actions">
            <button type="button" className="dev-btn" disabled={busy} onClick={() => answer(false)} data-testid="pair-no">
              {t('devices.no')}
            </button>
            {host ? (
              <button type="button" className="dev-btn is-primary" disabled={busy || !digitsOk} onClick={() => pick(typed.replace(/[\s-]/g, ''))} data-testid="pair-type-go">
                {t('account.pair.typeGo')}
              </button>
            ) : (
              <button type="button" className="dev-btn is-primary" disabled={busy} onClick={() => answer(true)} data-testid="pair-typed-it">
                {t('account.pair.typedIt', { name: pending.name })}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }
  if (pending.mode === 'check') {
    const acct = pending.account ?? null;
    const host = pending.role === 'host';
    const recent = acct !== null && acct.first_seen > 0 && Date.now() / 1000 - acct.first_seen < 24 * 3600;
    return (
      <div className="dev-scrim dev-scrim--top" data-testid="pair-confirm" data-account={acct ? 'true' : 'false'}>
        <div className="dev-sheet" role="alertdialog" aria-label={t('devices.title')}>
          <h2>{acct ? t(host ? 'account.pair.hostTitle' : 'account.pair.joinTitle', { name: pending.name }) : t('devices.check.title', { name: pending.name })}</h2>
          <p className="dev-note">{acct ? t(host ? 'account.pair.hostHelp' : 'account.pair.joinHelp', { name: pending.name }) : t('devices.check.pickHelp')}</p>
          {recent && (
            <p className="dev-error" role="alert" data-testid="pair-account-recent">
              {t('account.pair.recent')}
            </p>
          )}
          <div className="dev-picks">
            {(pending.choices ?? []).map((digits) => (
              <button key={digits} type="button" className="dev-pick" disabled={busy} onClick={() => pick(digits)} data-testid={`pair-pick-${digits}`}>
                {spaced(digits)}
              </button>
            ))}
          </div>
          <details className="dev-more">
            <summary>{t('devices.check.more')}</summary>
            {pending.fingerprint && (
              <p className="dev-note">
                {t('devices.check.fingerprint')} <span data-testid="pair-fingerprint">{pending.fingerprint}</span>
              </p>
            )}
            <p className="dev-note" data-testid="pair-none-hint">{t('devices.check.none')}</p>
          </details>
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
