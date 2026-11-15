// "Show a code": this PC shows a code and an address; the other device types them. The code works for 2 minutes.
import { useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n';
import { devicesApi, type DevicesApi, type DevicesView } from '../../lib/devices';
import { errorSentence } from '../../lib/sayError';
import { LinkBox } from './LinkBox';
import '../../styles/devices.css';

export function ShowCodeSheet({ view, api = devicesApi, onClose }: { view: DevicesView | null; api?: DevicesApi; onClose: () => void }) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const shown = useRef(false);
  useEffect(() => {
    api.showCode().catch((e: unknown) => setError(errorSentence(e)));
    return () => {
      api.cancelCode().catch(() => undefined);
    };
  }, [api]);
  // The code is withdrawn once it was used or timed out: the sheet has done its job.
  useEffect(() => {
    if (view?.hosting) shown.current = true;
    else if (shown.current) onClose();
  }, [view?.hosting, onClose]);
  const hosting = view?.hosting ?? null;
  return (
    <div className="dev-scrim" data-testid="show-code-sheet">
      <div className="dev-sheet" role="dialog" aria-label={t('devices.showCode')}>
        <h2>{t('devices.showCode')}</h2>
        {hosting?.kind === 'link' && hosting.link ? (
          <LinkBox link={hosting.link} />
        ) : hosting ? (
          <>
            <div className="dev-code" data-testid="the-code">
              {hosting.code}
            </div>
            <p className="dev-note">{t('devices.codeHelp')}</p>
            <label className="dev-field">
              <span>{t('devices.addressLabel')}</span>
              <input type="text" readOnly value={hosting.address} onFocus={(e) => e.currentTarget.select()} data-testid="the-address" />
            </label>
            <p className="dev-note">{t('devices.addressHelp')}</p>
          </>
        ) : (
          !error && <p className="dev-note">{t('devices.joining')}</p>
        )}
        {error && (
          <p className="dev-error" role="alert">
            {error}
          </p>
        )}
        <div className="dev-actions">
          <button type="button" className="dev-btn" onClick={onClose} data-testid="show-code-close">
            {t('devices.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
