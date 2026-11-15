// One file transfer, the list of a device's transfers, and the one question "A file named X is already there."
// Names and errors come from the far device: text only.
import { useT } from '../../i18n';
import { progressParts } from '../../lib/deviceFiles';
import { clipText, devicesApi, type DevicesApi, type Transfer } from '../../lib/devices';
import { errorSentence } from '../../lib/sayError';
import { useTransfers, type FileOps } from './useFileOps';
import '../../styles/devices.css';

export function TransferRow({ transfer, api = devicesApi }: { transfer: Transfer; api?: DevicesApi }) {
  const t = useT();
  const { done, total } = progressParts(transfer.bytes, transfer.total);
  const pct = transfer.total > 0 ? Math.min(100, Math.round((transfer.bytes / transfer.total) * 100)) : transfer.state === 'done' ? 100 : 0;
  const stateWord = transfer.state === 'running' ? t('devices.xfer.running') : transfer.state === 'done' ? t('devices.xfer.done') : transfer.state === 'failed' ? t('devices.xfer.failed') : t('devices.xfer.stopped');
  return (
    <li className="dev-xfer" data-testid={`transfer-${transfer.id}`} data-state={transfer.state}>
      <div className="dev-xfer-top">
        <b className="dev-xfer-name">{clipText(transfer.name, 120)}</b>
        <span className="dev-word">{transfer.dir === 'down' ? t('devices.xfer.down') : t('devices.xfer.up')}</span>
        <span className="dev-word" data-testid="transfer-state">
          {stateWord}
        </span>
        {transfer.state === 'running' && (
          <button type="button" className="dev-btn is-plain" onClick={() => void api.transferCancel(transfer.id).catch(() => undefined)} data-testid="transfer-stop">
            {t('devices.xfer.stop')}
          </button>
        )}
      </div>
      <div className="dev-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <span style={{ width: `${pct}%` }} />
      </div>
      <small>{t('devices.xfer.progress', { done, total })}</small>
      {transfer.state === 'done' && transfer.saved_as !== '' && transfer.dir === 'down' && <small data-testid="transfer-saved">{t('devices.xfer.saved', { name: clipText(transfer.saved_as, 200) })}</small>}
      {transfer.state === 'failed' && transfer.error !== '' && (
        <small className="dev-xfer-error" data-testid="transfer-error">
          {clipText(transfer.error, 300)}
        </small>
      )}
    </li>
  );
}

/** A device's transfers, newest first, with Clear finished. Draws nothing when there are none. */
export function Transfers({ api = devicesApi, node }: { api?: DevicesApi; node: string }) {
  const t = useT();
  const list = useTransfers(api, node);
  if (list.length === 0) return null;
  const finished = list.some((x) => x.state !== 'running');
  return (
    <div className="dev-xfers" data-testid="transfers">
      <div className="dev-row">
        <h4 className="dev-grow">{t('devices.xfer.title')}</h4>
        {finished && (
          <button type="button" className="dev-btn is-plain" onClick={() => void api.transfersClear().catch((e: unknown) => errorSentence(e))} data-testid="transfers-clear">
            {t('devices.xfer.clear')}
          </button>
        )}
      </div>
      <ul className="dev-list">
        {list.map((x) => (
          <TransferRow key={x.id} transfer={x} api={api} />
        ))}
      </ul>
    </div>
  );
}

/** The question and its three answers. Replace is never sent without this click. */
export function ExistsQuestion({ ops }: { ops: Pick<FileOps, 'question' | 'answer'> }) {
  const t = useT();
  if (ops.question === null) return null;
  return (
    <div className="dev-confirm" role="alertdialog" data-testid="exists-question">
      <p>{t('devices.xfer.exists', { name: ops.question })}</p>
      <div className="dev-actions">
        <button type="button" className="dev-btn" onClick={() => ops.answer('replace')} data-testid="exists-replace">
          {t('devices.xfer.replace')}
        </button>
        <button type="button" className="dev-btn" onClick={() => ops.answer('both')} data-testid="exists-both">
          {t('devices.xfer.both')}
        </button>
        <button type="button" className="dev-btn is-plain" onClick={() => ops.answer(null)} data-testid="exists-cancel">
          {t('devices.cancel')}
        </button>
      </div>
    </div>
  );
}
