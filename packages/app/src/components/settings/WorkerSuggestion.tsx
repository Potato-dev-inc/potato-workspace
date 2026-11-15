// "Use <address>": one Worker does the team relay, the phone link and invite links, so an address saved in one
// place is offered in the other. It is offered only when the Worker says it can do the job; an older deploy gets
// "Update your Worker" with the one command, and nothing is sent to it. Nothing here sends a secret.
import { useEffect, useState } from 'react';
import { useT } from '../../i18n';
import { verdictFor, workerCheck, type WorkerFeature, type WorkerHealth, type WorkerVerdict } from '../../lib/worker';
import type { UpdateApi } from '../../lib/workerUpdate';
import { WorkerUpdateButton } from './WorkerUpdateButton';

export function WorkerSuggestion({
  address,
  current,
  feature,
  useKey,
  noteKey,
  onUse,
  check = workerCheck,
  updateApi,
}: {
  /** The address saved in the other place, if any. */
  address: string | null;
  /** What is typed here now: nothing is offered when it is already the same. */
  current: string;
  /** What this place needs the Worker to be able to do. */
  feature: WorkerFeature;
  /** The i18n key of the "Use {url} ..." button text. */
  useKey: 'stable.useRelay' | 'worker.useLink';
  noteKey?: 'stable.relayNote' | 'worker.linkNote';
  onUse: (url: string) => void;
  check?: (address: string) => Promise<WorkerHealth | null>;
  /** Tests give their own; the default runs the steps in the desktop shell. */
  updateApi?: UpdateApi;
}) {
  const t = useT();
  const [verdict, setVerdict] = useState<WorkerVerdict | null>(null);
  const [again, setAgain] = useState(0);
  useEffect(() => {
    setVerdict(null);
    if (!address) return;
    let alive = true;
    void Promise.resolve()
      .then(() => check(address))
      .then((h) => alive && setVerdict(verdictFor(h, feature)))
      .catch(() => alive && setVerdict('unknown'));
    return () => {
      alive = false;
    };
  }, [address, feature, check, again]);

  if (!address || verdict === null || address === current.trim().replace(/\/+$/, '')) return null;

  if (verdict === 'update') {
    return (
      <div data-testid="worker-update" className="stable-update">
        <strong>{t('worker.update')}</strong>
        <p>{t('worker.updateWhy', { url: address })}</p>
        <WorkerUpdateButton address={address} label="wu.update" api={updateApi} onDone={() => setAgain((n) => n + 1)} />
      </div>
    );
  }
  if (verdict === 'unreachable') {
    return (
      <p data-testid="worker-unreachable" className="stable-update">
        {t('worker.unreachable', { url: address })}
      </p>
    );
  }
  return (
    <p data-testid="stable-relay-suggestion">
      <button type="button" className="st-linkbtn stable-keep" onClick={() => onUse(address)}>
        {t(useKey, { url: address })}
      </button>
      {noteKey && <span className="block">{t(noteKey)}</span>}
    </p>
  );
}
