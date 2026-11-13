// Settings: the version line and "Check for updates". The same flow as the notice, with a button that says what it found.
import { useT } from '../../../i18n';
import { tauriUpdateTransport, type UpdateTransport } from '../../../lib/app-update';
import { UpdateNoticeView } from '../../updates/UpdateNotice';
import { useAppUpdate } from '../../updates/useAppUpdate';
import { Btn, Note, SettingRow } from '../settings-ui';

export function UpdateRow({ transport = tauriUpdateTransport, versionLine = '' }: { transport?: UpdateTransport; versionLine?: string }) {
  const t = useT();
  const state = useAppUpdate(transport, false);
  const checking = state.phase === 'checking';
  return (
    <SettingRow
      label={t('overview.version.label')}
      description={versionLine ? t('overview.version.line', { version: versionLine }) : t('overview.version.noLine')}
    >
      <div className="app-update-row">
        <Btn disabled={checking || state.phase === 'installing'} onClick={() => void state.check(true)}>
          {checking ? t('overview.version.checking') : t('overview.version.check')}
        </Btn>
        {state.phase === 'none' && <Note>{t('overview.version.newest')}</Note>}
        <UpdateNoticeView state={state} />
      </div>
    </SettingRow>
  );
}
