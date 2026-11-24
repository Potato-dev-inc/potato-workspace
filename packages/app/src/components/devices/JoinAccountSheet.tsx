// "Add <machine> to your account?": the signed-in PC answers the code a screen-less machine (an SSH box) printed. The code reached this PC
// over the person's own SSH, never through the account server. Add lets the machine sign itself in; Not me refuses it. No login crosses.
import { useState } from 'react';
import { useT } from '../../i18n';
import { accountApi, type AccountApi } from '../../lib/account';
import { errorSentence } from '../../lib/sayError';
import { Sheet } from '../cockpit/Sheet';

export function JoinAccountSheet({ name, code, api = accountApi, onDone }: { name: string; code: string; api?: Pick<AccountApi, 'approveDevice'>; onDone: (answer: 'added' | 'refused' | 'later') => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answer = (allow: boolean) => {
    setBusy(true);
    setError(null);
    (api.approveDevice?.(code, allow) ?? Promise.reject(new Error('Not available here.')))
      .then(() => onDone(allow ? 'added' : 'refused'))
      .catch((e: unknown) => {
        setError(errorSentence(e));
        setBusy(false);
      });
  };
  return (
    <Sheet labelledBy="ck-joinacct-t" onClose={busy ? undefined : () => onDone('later')}>
      <h2 className="ck-section" id="ck-joinacct-t">
        {t('devices.join.title', { name })}
      </h2>
      <p className="ck-sub">{t('devices.join.body')}</p>
      <p className="dev-code" data-testid="join-code">
        {code}
      </p>
      {error && (
        <p className="dev-error" role="alert">
          {error}
        </p>
      )}
      <div className="dev-actions">
        <button type="button" className="dev-btn" disabled={busy} onClick={() => answer(false)} data-testid="join-refuse">
          {t('devices.join.refuse')}
        </button>
        <button type="button" className="dev-btn is-primary" disabled={busy} onClick={() => answer(true)} data-testid="join-add">
          {t('devices.join.add')}
        </button>
      </div>
    </Sheet>
  );
}
