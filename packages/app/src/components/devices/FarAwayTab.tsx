// "Far away": one device makes a pairing link (valid 10 minutes, works once), the other pastes it. The link gives no
// rights by itself: both people still confirm, on the same sheet as a code. If the relay is off, the error says so.
import { useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n';
import type { DevicesApi, DevicesView } from '../../lib/devices';
import { errorSentence } from '../../lib/sayError';
import { LinkBox } from './LinkBox';
import '../../styles/devices.css';

export function FarAwayTab({ view, api, onJoined }: { view: DevicesView | null; api: DevicesApi; onJoined: () => void }) {
  const t = useT();
  const [made, setMade] = useState<string | null>(null);
  const [pasted, setPasted] = useState('');
  const [busy, setBusy] = useState(false);
  const [madeViaRelay, setMadeViaRelay] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const asked = useRef(false);
  const hosted = view?.hosting?.kind === 'link' ? (view.hosting.link ?? null) : null;
  const link = hosted ?? made;
  const viaRelay = hosted ? view?.hosting?.worker === true : madeViaRelay;
  // A link that was made here is withdrawn when the sheet or the tab goes away.
  useEffect(
    () => () => {
      if (asked.current) api.cancelCode().catch(() => undefined);
    },
    [api],
  );
  const make = () => {
    setError(null);
    asked.current = true;
    api
      .makeLink()
      .then((v) => {
        setMade(v.hosting?.kind === 'link' ? (v.hosting.link ?? null) : null);
        setMadeViaRelay(v.hosting?.worker === true);
      })
      .catch((e: unknown) => setError(errorSentence(e)));
  };
  const join = () => {
    setBusy(true);
    setError(null);
    api
      .joinLink(pasted.trim())
      .then(onJoined)
      .catch((e: unknown) => {
        setError(errorSentence(e));
        setBusy(false);
      });
  };
  return (
    <div className="dev-form" data-testid="far-tab">
      <p className="dev-note">{t('devices.far.makeHelp')}</p>
      {link ? (
        <LinkBox link={link} />
      ) : (
        <div className="dev-row">
          <button type="button" className="dev-btn" onClick={make} data-testid="make-link">
            {t('devices.makeLink')}
          </button>
        </div>
      )}
      {link && viaRelay && (
        <p className="dev-note" data-testid="far-via-relay">
          {t('devices.far.viaRelay')}
        </p>
      )}
      <label className="dev-field">
        <span>{t('devices.pasteLink')}</span>
        <input type="text" value={pasted} placeholder={t('devices.linkPlaceholder')} onChange={(e) => setPasted(e.target.value)} data-testid="paste-link" />
      </label>
      <div className="dev-row">
        <button type="button" className="dev-btn is-primary" disabled={busy || pasted.trim() === ''} onClick={join} data-testid="join-link-go">
          {busy ? t('devices.joining') : t('devices.join')}
        </button>
      </div>
      {busy && view?.joining && <p className="dev-note">{view.joining}</p>}
      {error && (
        <p className="dev-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
