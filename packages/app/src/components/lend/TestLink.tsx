import { useT } from '../../i18n';
import { useEffect, useRef, useState } from 'react';
import { errText, lendApi, type LendApi, type LinkTest } from '../../lib/lend';

/**
 * "Test link" on a lend row (either side). It opens the real link handshake to the other PC (borrower) or checks this
 * PC's side and pings the borrower (lender), and says in plain words what it found. Nothing is sent to the agent.
 */
export function TestLink({ grantId, api = lendApi }: { grantId: string; api?: LendApi }) {
  const t = useT();
  const [busy, setBusy] = useState(true);
  const [result, setResult] = useState<LinkTest | null>(null);
  const alive = useRef(true);
  // The link is tested by itself when the row shows: there is no button, only the result line.
  useEffect(() => {
    alive.current = true;
    if (!api.testLink) return;
    void (async () => {
      try {
        const r = await api.testLink!(grantId);
        if (alive.current) setResult(r);
      } catch (err) {
        if (alive.current) setResult({ ok: false, ms: null, via: null, message: errText(err) });
      } finally {
        if (alive.current) setBusy(false);
      }
    })();
    return () => {
      alive.current = false;
    };
  }, [api, grantId]);
  if (!api.testLink) return null;
  return (
    <span className="lend-test">
      {busy && <small className="lend-muted">{t('lend.testing')}</small>}
      {result && (
        <small className={result.ok ? 'lend-test-ok' : 'lend-problem'} role="status" data-testid="lend-test-result">
          {result.message}
        </small>
      )}
    </span>
  );
}
