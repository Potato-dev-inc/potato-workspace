// "Use <address>": one Worker does the team relay, the phone link and invite links, so an address saved in one
// place is offered in the other. It is offered only when the Worker says it can do the job; an older deploy gets
// "Update your Worker" with the one command, and nothing is sent to it. Nothing here sends a secret.
import { useEffect, useState } from 'react';
import { useT } from '../../i18n';
import { tauri } from '../../lib/tauri';
import { verdictFor, workerCheck, WORKER_GUIDE_URL, WORKER_UPDATE_COMMAND, type WorkerFeature, type WorkerHealth, type WorkerVerdict } from '../../lib/worker';
import { Btn } from './settings-ui';

export function WorkerSuggestion({
  address,
  current,
  feature,
  useKey,
  noteKey,
  onUse,
  check = workerCheck,
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
}) {
  const t = useT();
  const [verdict, setVerdict] = useState<WorkerVerdict | null>(null);
  const [copied, setCopied] = useState(false);
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
  }, [address, feature, check]);

  if (!address || verdict === null || address === current.trim().replace(/\/+$/, '')) return null;

  if (verdict === 'update') {
    return (
      <div data-testid="worker-update" className="stable-update">
        <strong>{t('worker.update')}</strong>
        <p>{t('worker.updateWhy', { url: address })}</p>
        <div className="stable-cmd">
          <code className="font-mono break-all">{WORKER_UPDATE_COMMAND}</code>
          <Btn
            small
            aria-label={`${t('settings.copy')}: ${WORKER_UPDATE_COMMAND}`}
            onClick={() => {
              void navigator.clipboard?.writeText(WORKER_UPDATE_COMMAND).catch(() => undefined);
              setCopied(true);
            }}
          >
            {copied ? t('tunnel.secretCopied') : t('settings.copy')}
          </Btn>
        </div>
        <button type="button" className="st-linkbtn" onClick={() => void tauri.openExternalUrl(WORKER_GUIDE_URL)}>
          {t('stable.guide')}
        </button>
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
