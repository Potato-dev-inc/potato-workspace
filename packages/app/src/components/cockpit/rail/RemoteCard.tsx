// "Remote control" for this agent: one switch for whether paired phones can reach it, how far they may go
// (watch / answer / full, never above the phone's own level), and the paired phones. The bridge enforces the rule
// for every phone request; this card only sets it. With no phone paired it offers "Pair a phone" instead.
import type { PairedDeviceInfo } from '@potato-workspace/shared';
import { useCallback, useEffect, useId, useState } from 'react';
import { useT } from '../../../i18n';
import { openSettingsAt } from '../../../lib/openSettingsAt';
import { effectiveLevel, PANE_REMOTE_LEVELS, type PaneRemote, type PaneRemoteLevel } from '../../../lib/pane-remote';
import { tauri } from '../../../lib/tauri';
import { RailCard } from './RailCard';

export interface RemoteApi {
  get: (paneId: string) => Promise<PaneRemote>;
  set: (paneId: string, change: { remote?: boolean; level?: PaneRemoteLevel }) => Promise<PaneRemote>;
  phones: () => Promise<PairedDeviceInfo[]>;
}

export const tauriRemoteApi: RemoteApi = {
  get: (paneId) => tauri.getPaneRemote(paneId),
  set: (paneId, change) => tauri.setPaneRemote(paneId, change),
  phones: () => tauri.listPairedMobileDevices(),
};

const LEVEL_WORD = { watch: 'pane.remoteWatch', answer: 'pane.remoteAnswer', full: 'pane.remoteFull' } as const;
const LEVEL_TIP = { watch: 'pane.remoteWatchTip', answer: 'pane.remoteAnswerTip', full: 'pane.remoteFullTip' } as const;

export function RemoteCard({ paneId, api = tauriRemoteApi, onPair }: { paneId: string; api?: RemoteApi; onPair?: () => void }) {
  const t = useT();
  const labelId = useId();
  const [rule, setRule] = useState<PaneRemote | null>(null);
  const [phones, setPhones] = useState<PairedDeviceInfo[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setRule(null);
    setPhones(null);
    void api.get(paneId).then((r) => live && setRule(r)).catch(() => live && setRule({ remote: true, level: 'full' }));
    void api.phones().then((p) => live && setPhones(p.filter((d) => !d.expired))).catch(() => live && setPhones([]));
    return () => {
      live = false;
    };
  }, [api, paneId]);

  const change = useCallback(
    (next: { remote?: boolean; level?: PaneRemoteLevel }) => {
      if (!rule) return;
      const before = rule;
      setFailed(false);
      setRule({ ...rule, ...next });
      api.set(paneId, next).then(setRule).catch(() => {
        setRule(before);
        setFailed(true);
      });
    },
    [api, paneId, rule],
  );

  if (!rule || !phones) return null;
  const pair = onPair ?? (() => openSettingsAt('phone'));
  return (
    <RailCard title={t('pane.remoteTitle')} testId="rail-remote">
      {phones.length === 0 ? (
        <>
          <p className="ck-rail-line">{t('pane.remoteNone')}</p>
          <button type="button" className="ck-btn ck-btn--secondary ck-btn--sm ck-rail-action" onClick={pair} title={t('pane.remotePairTip')}>
            {t('pane.remotePair')}
          </button>
          {/* A computer pairs the same way for now (the pairing flow is not split by device kind yet). */}
          <button type="button" className="ck-btn ck-btn--plain ck-btn--sm ck-rail-action" onClick={pair} title={t('pane.remoteConnectPcTip')}>
            {t('pane.remoteConnectPc')}
          </button>
        </>
      ) : (
        <>
          <div className="ck-menu-toggle">
            <span id={labelId}>{t('pane.remoteSwitch')}</span>
            <button type="button" role="switch" aria-checked={rule.remote} aria-labelledby={labelId} className="ck-switch" onClick={() => change({ remote: !rule.remote })}>
              <span className="ck-switch-knob" />
            </button>
          </div>
          <p className="ck-rail-line">{rule.remote ? t('pane.remoteOnNote') : t('pane.remoteOffNote')}</p>
          <div className="ck-seg" role="radiogroup" aria-label={t('pane.remoteLevel')} data-disabled={rule.remote ? undefined : ''} style={{ ['--n' as string]: 3, ['--i' as string]: PANE_REMOTE_LEVELS.indexOf(rule.level) }}>
            <span className="ck-seg-thumb" aria-hidden="true" />
            {PANE_REMOTE_LEVELS.map((level) => (
              <button key={level} type="button" role="radio" aria-checked={rule.level === level} disabled={!rule.remote} className="ck-seg-btn" title={t(LEVEL_TIP[level])} onClick={() => rule.level !== level && change({ level })}>
                {t(LEVEL_WORD[level])}
              </button>
            ))}
          </div>
          <ul className="ck-rail-list" aria-label={t('pane.remotePhones')}>
            {phones.map((phone) => {
              const level = effectiveLevel(rule, phone.caps);
              return (
                <li key={phone.id} className="ck-rail-line" data-testid="rail-remote-phone">
                  <span className="ck-rail-file">{phone.name}</span> <span className="ck-rail-folder">{level ? t(LEVEL_TIP[level]) : t('pane.remoteNoAccess')}</span>
                </li>
              );
            })}
          </ul>
          <p className="ck-rail-line">{t('pane.remoteLiveNote')}</p>
          {failed && (
            <p className="ck-rail-line" role="alert">
              {t('pane.remoteFailed')}
            </p>
          )}
        </>
      )}
    </RailCard>
  );
}
