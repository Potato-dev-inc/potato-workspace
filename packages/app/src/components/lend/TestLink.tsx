import { useT } from '../../i18n';
import { useEffect, useRef, useState } from 'react';
import { errText, lendApi, type LendApi, type LinkTest } from '../../lib/lend';

// The lender PC sends this sentence in English; show it in the app language.
const LINK_OPEN_EN = "OK. The borrower's PC has a link open right now.";

/**
 * "Test link" on a lend row (either side). It opens the real link handshake to the other PC (borrower) or checks this
 * PC's side and pings the borrower (lender), and says in plain words what it found. Nothing is sent to the agent.
 */
export function TestLink({ grantId, api = lendApi }: { grantId: string; api?: LendApi }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<LinkTest | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  if (!api.testLink) return null;
  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      const r = await api.testLink!(grantId);
      if (alive.current) setResult(r);
    } catch (err) {
      if (alive.current) setResult({ ok: false, ms: null, via: null, message: errText(err) });
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  return (
    <span className="lend-test">
      <button type="button" className="lend-btn is-small" disabled={busy} onClick={() => void run()}>
        {busy ? t('lend.testing') : t('lend.testLink')}
      </button>
      {result && (
        <small className={result.ok ? 'lend-test-ok' : 'lend-problem'} role="status" data-testid="lend-test-result">
          {result.message === LINK_OPEN_EN ? t('lend.test.linkOpen') : result.message}
        </small>
      )}
    </span>
  );
}
