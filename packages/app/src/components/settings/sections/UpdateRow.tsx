// Settings: the version line and "Check for updates". The same flow as the notice, with a button that says what it found.
import { tauriUpdateTransport, type UpdateTransport } from '../../../lib/app-update';
import { UpdateNoticeView } from '../../updates/UpdateNotice';
import { useAppUpdate } from '../../updates/useAppUpdate';
import { Btn, Note, SettingRow } from '../settings-ui';

export function UpdateRow({ transport = tauriUpdateTransport, versionLine = '' }: { transport?: UpdateTransport; versionLine?: string }) {
  const state = useAppUpdate(transport, false);
  const checking = state.phase === 'checking';
  return (
    <SettingRow
      label="Version"
      description={`${versionLine ? `Version ${versionLine}. ` : ''}Nothing installs until you press Update.`}
    >
      <div className="app-update-row">
        <Btn disabled={checking || state.phase === 'installing'} onClick={() => void state.check(true)}>
          {checking ? 'Checking…' : 'Check for updates'}
        </Btn>
        {state.phase === 'none' && <Note>You have the newest version.</Note>}
        <UpdateNoticeView state={state} />
      </div>
    </SettingRow>
  );
}
