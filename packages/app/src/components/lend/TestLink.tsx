import { useT } from '../../i18n';
import { useState } from 'react';
import { errText, lendApi, type LendApi, type LinkTest } from '../../lib/lend';

/**
 * "Test link" on a lend row (either side). It opens the real link handshake to the other PC (borrower) or checks this
 * PC's side and pings the borrower (lender), and says in plain words what it found. Nothing is sent to the agent.
 */
export function TestLink({ grantId, api = lendApi }: { grantId: string; api?: LendApi }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<LinkTest | null>(null);
  if (!api.testLink) return null;
  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      setResult(await api.testLink!(grantId));
    } catch (err) {
      setResult({ ok: false, ms: null, via: null, message: errText(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="lend-test">
      <button type="button" className="lend-btn is-small" disabled={busy} onClick={() => void run()}>
        {busy ? t('lend.testing') : t('lend.testLink')}
      </button>
      {result && (
        <small className={result.ok ? 'lend-test-ok' : 'lend-problem'} role="status" data-testid="lend-test-result">
          {result.message}
        </small>
      )}
    </span>
  );
}
