// Settings: the version line and "Check for updates". The same flow as the notice, with a button that says what it found.
import { useEffect, useRef, useState } from 'react';
import { useT } from '../../../i18n';
import { tauriUpdateTransport, type UpdateTransport } from '../../../lib/app-update';
import { ToolsRepairLine } from '../../updates/ToolsMissingNotice';
import { UpdateNoticeView } from '../../updates/UpdateNotice';
import { useAppUpdate } from '../../updates/useAppUpdate';
import { Btn, Note, SettingRow } from '../settings-ui';

export function UpdateRow({ transport = tauriUpdateTransport, versionLine = '' }: { transport?: UpdateTransport; versionLine?: string }) {
  const t = useT();
  const state = useAppUpdate(transport, false);
  const checking = state.phase === 'checking';
  // When the last check finished: a second press shows a new time, so a result that did not change still answers.
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const wasChecking = useRef(false);
  useEffect(() => {
    if (checking) wasChecking.current = true;
    else if (wasChecking.current) {
      wasChecking.current = false;
      setCheckedAt(new Date());
    }
  }, [checking]);
  // The page checks by itself when it opens; the button stays for a second look.
  const { check } = state;
  useEffect(() => {
    void check(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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
        {checkedAt && !checking && (
          <Note role="status">{t("overview.version.checkedAt", { time: checkedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) })}</Note>
        )}
        <UpdateNoticeView state={state} floating={false} />
        <ToolsRepairLine transport={transport} />
      </div>
    </SettingRow>
  );
}
