// "Start a team" > the recommended way: ONE relay per person. If this PC already has a relay Worker (the one the phone
// uses), the team is made on it with no Cloudflare token. If not, the one guided setup (the same as the phone's) runs
// once, and from then on this card says "Use my relay". The token way lives under "Other ways". No secret is shown or
// sent here: the team makes its own keys, and the phone keeps its own secret.
import { useEffect, useState } from 'react';
import { useT } from '../../../i18n';
import { oneRelay } from '../../../lib/relay';
import type { TunnelStatus } from '../../../lib/tauri-types';
import { verdictFor, workerCheck, type WorkerHealth, type WorkerVerdict } from '../../../lib/worker';
import type { UpdateApi } from '../../../lib/workerUpdate';
import { defaultTunnelApi } from '../../PairingAddress';
import { StableLinkSheet } from '../../StableLinkSheet';
import type { TunnelApi } from '../TunnelSection';
import { WorkerUpdateButton } from '../WorkerUpdateButton';
import { Btn } from '../settings-ui';

const hostOf = (address: string): string => address.replace(/^https:\/\//, '');

export function RelayChoice({
  address,
  disabled,
  onUse,
  onSaved,
  check = workerCheck,
  updateApi,
  tunnelApi = defaultTunnelApi,
}: {
  /** The relay already set up on this PC, or null. */
  address: string | null;
  /** Busy, or the team still has no name. */
  disabled: boolean;
  /** Make the team on this relay. */
  onUse: (address: string) => void;
  /** The one guided setup saved a relay. */
  onSaved: (address: string) => void;
  check?: (address: string) => Promise<WorkerHealth | null>;
  updateApi?: UpdateApi;
  tunnelApi?: TunnelApi;
}) {
  const t = useT();
  const [verdict, setVerdict] = useState<WorkerVerdict | null>(null);
  const [again, setAgain] = useState(0);
  const [sheet, setSheet] = useState<{ status: TunnelStatus | null } | null>(null);
  // The guided setup saves a Worker before it is finished (the secret is shown once in its last step). The card only
  // flips to "Use my relay" when the sheet is closed, so the sheet is never unmounted in the middle of the setup.
  const [made, setMade] = useState<string | null>(null);

  useEffect(() => {
    setVerdict(null);
    if (!address) return;
    let alive = true;
    void Promise.resolve()
      .then(() => check(address))
      .then((h) => alive && setVerdict(verdictFor(h, 'team')))
      .catch(() => alive && setVerdict('unknown'));
    return () => {
      alive = false;
    };
  }, [address, check, again]);

  const openSetup = () => {
    void Promise.resolve()
      .then(() => tunnelApi.getStatus())
      .catch(() => null)
      .then((status) => setSheet({ status }));
  };

  const sheetEl = sheet && (
    <StableLinkSheet
      api={tunnelApi}
      initial={sheet.status}
      onStatus={(s) => {
        const r = oneRelay(s);
        if (r) setMade(r.address);
      }}
      onClose={() => {
        setSheet(null);
        if (made) onSaved(made);
      }}
      checkWorker={check}
      updateApi={updateApi}
    />
  );

  if (address) {
    const ready = verdict === 'ok' || verdict === 'unknown';
    return (
      <>
      <div className="tp-way tp-way-main" data-testid="relay-use">
        <div>
          <strong>{t('teamPage.useMyRelay', { host: hostOf(address) })}</strong> <span className="tp-tag">{t('teamPage.recommended')}</span>
          <p className="tp-sub">{verdict === null ? t('teamPage.relayChecking') : verdict === 'unreachable' ? t('teamPage.relayDown') : t('teamPage.useMyRelayHelp')}</p>
          {verdict === 'update' && (
            <div data-testid="worker-update" className="stable-update">
              <strong>{t('worker.update')}</strong>
              <p>{t('worker.updateWhy', { url: address })}</p>
              <WorkerUpdateButton address={address} label="wu.update" api={updateApi} onDone={() => setAgain((n) => n + 1)} />
            </div>
          )}
        </div>
        {verdict === 'unreachable' && (
          <Btn onClick={() => setAgain((n) => n + 1)}>{t('teamPage.relayRetry')}</Btn>
        )}
        <Btn primary disabled={disabled || !ready} onClick={() => onUse(address)}>
          {t('teamPage.createTeam')}
        </Btn>
      </div>
      {sheetEl}
      </>
    );
  }
  return (
    <div className="tp-way tp-way-main" data-testid="relay-setup">
      <div>
        <strong>{t('teamPage.setUpRelay')}</strong> <span className="tp-tag">{t('teamPage.recommended')}</span>
        <p className="tp-sub">{t('teamPage.setUpRelayHelp')}</p>
      </div>
      <Btn primary onClick={openSetup}>
        {t('teamPage.setUpRelay')}
      </Btn>
      {sheetEl}
    </div>
  );
}
