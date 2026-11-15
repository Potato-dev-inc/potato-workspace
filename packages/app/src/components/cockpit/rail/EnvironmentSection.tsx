// Environment: where this chat runs and what it works on. Five plain rows; the Remote control switch is the only control.
import { useCallback, useEffect, useState } from 'react';
import { useT } from '../../../i18n';
import { openSettingsAt } from '../../../lib/openSettingsAt';
import { PANE_REMOTE_LEVELS, type PaneRemote, type PaneRemoteLevel } from '../../../lib/pane-remote';
import { RailSection } from './RailSection';
import { tauriRemoteApi, type RemoteApi } from './remoteApi';
import { baseName } from './railFormat';

const LEVEL_WORD = { watch: 'pane.remoteWatch', answer: 'pane.remoteAnswer', full: 'pane.remoteFull' } as const;

export interface EnvironmentProps {
  paneId: string;
  cwd: string;
  /** The device name when the chat runs on another computer; null: this computer. */
  runsOn: string | null;
  /** The git branch of the folder; null when it is not a git folder (or not known yet). */
  branch: string | null;
  /** The chat works on a copy of its project. */
  copy: { kind: 'git' | 'plain' } | null;
  onOpenFolder?: () => void;
  onOpenCopy?: () => void;
  api?: RemoteApi;
  onPair?: () => void;
}

export function EnvironmentSection({ paneId, cwd, runsOn, branch, copy, onOpenFolder, onOpenCopy, api = tauriRemoteApi, onPair }: EnvironmentProps) {
  const t = useT();
  const [rule, setRule] = useState<PaneRemote | null>(null);
  const [phones, setPhones] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setRule(null);
    setPhones(null);
    void api.get(paneId).then((r) => live && setRule(r)).catch(() => live && setRule({ remote: true, level: 'full' }));
    void api.phones().then((p) => live && setPhones(p.filter((d) => !d.expired).length)).catch(() => live && setPhones(0));
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
      api
        .set(paneId, next)
        .then(setRule)
        .catch(() => {
          setRule(before);
          setFailed(true);
        });
    },
    [api, paneId, rule],
  );
  const flip = () => rule && change({ remote: !rule.remote });

  const where = runsOn ?? t('rail.env.thisComputer');
  const folder = baseName(cwd);
  const copyText = copy ? t('rail.env.copyOn', { kind: copy.kind === 'git' ? t('rail.env.copyKindGit') : t('rail.env.copyKindPlain') }) : t('rail.env.copyOff');
  const summary = [where, branch].filter(Boolean).join(' · ');
  const remoteOn = !!rule?.remote && (phones ?? 0) > 0;

  return (
    <RailSection id="env" title={t('rail.env.title')} summary={summary}>
      <div className="rp-row">
        <span className="rp-k">{t('rail.env.runsOn')}</span>
        <span className="rp-v">{where}</span>
      </div>
      {onOpenFolder ? (
        <button type="button" className="rp-row rp-btn" title={cwd} onClick={onOpenFolder}>
          <span className="rp-k">{t('rail.env.folder')}</span>
          <span className="rp-v">{folder}</span>
        </button>
      ) : (
        <div className="rp-row" title={cwd}>
          <span className="rp-k">{t('rail.env.folder')}</span>
          <span className="rp-v">{folder}</span>
        </div>
      )}
      {branch && (
        <div className="rp-row" title={branch}>
          <span className="rp-k">{t('rail.env.branch')}</span>
          <span className="rp-v rp-mono">{branch}</span>
        </div>
      )}
      {onOpenCopy ? (
        <button type="button" className="rp-row rp-btn" onClick={onOpenCopy}>
          <span className="rp-k">{t('rail.env.copy')}</span>
          <span className={`rp-v${copy ? '' : ' is-dim'}`}>{copyText}</span>
        </button>
      ) : (
        <div className="rp-row">
          <span className="rp-k">{t('rail.env.copy')}</span>
          <span className={`rp-v${copy ? '' : ' is-dim'}`}>{copyText}</span>
        </div>
      )}
      {rule && phones !== null && (
        phones === 0 ? (
          <button type="button" className="rp-row rp-btn" title={t('rail.env.remotePair')} onClick={onPair ?? (() => openSettingsAt('phone'))}>
            <span className="rp-k">{t('rail.env.remote')}</span>
            <span className="rp-v is-dim">{t('rail.env.remoteOff')}</span>
          </button>
        ) : (
          <div className="rp-row">
            <span className="rp-k">{t('rail.env.remote')}</span>
            <span className={`rp-v ${remoteOn ? 'is-ok' : 'is-dim'}`}>{remoteOn ? t('rail.env.remoteOn') : t('rail.env.remoteOff')}</span>
            <button type="button" role="switch" aria-checked={rule.remote} aria-label={t('rail.env.remote')} className="rp-sw" onClick={flip} />
          </div>
        )
      )}
      {rule?.remote && (phones ?? 0) > 0 && (
        <div className="rp-row rp-sub" role="radiogroup" aria-label={t('pane.remoteLevel')} data-testid="rail-remote-level">
          {PANE_REMOTE_LEVELS.map((level) => (
            <button key={level} type="button" role="radio" aria-checked={rule.level === level} className={'rp-mini' + (rule.level === level ? ' is-on' : '')} onClick={() => rule.level !== level && change({ level })}>
              {t(LEVEL_WORD[level])}
            </button>
          ))}
        </div>
      )}
      {failed && (
        <p className="rp-note" role="alert">
          {t('rail.env.remoteFailed')}
        </p>
      )}
    </RailSection>
  );
}
