// Settings > Agents > Chat add-ons: one row per agent that can run as a chat. "Chat add-on: Installed 0.74.0 · Remove" or
// "Not installed · Install". Shown only while Chat (ACP) is on in Labs (the row is also hidden by its `labsFlag`).
// Remove moves the add-on aside (nothing is deleted); Install runs the pinned, checked install. Nothing here names an agent.
import { useAcpAddons } from '../../../hooks/useAcpAddons';
import { en } from '../../../i18n/en';
import { t, useT } from '../../../i18n';
import { progressText, rowText, sizeText, tauriAcpAddonApi, type AcpAddonApi, type AddonStatus } from '../../../lib/acpAddon';
import { Btn, Note, SettingRow } from '../settings-ui';

export const CHAT_ADDONS_LABEL = en['settings.row.chat-addons.label'];
export const CHAT_ADDONS_NOTE = en['addon.note'];

function AddonRow({ status, error, onInstall, onRemove }: { status: AddonStatus; error?: string; onInstall: () => void; onRemove: () => void }) {
  const t = useT();
  const installing = status.state === 'installing';
  const installed = status.state === 'installed';
  const failed = status.state === 'failed';
  return (
    <SettingRow label={t('addon.rowLabel', { label: status.label })} description={installed || installing || failed ? undefined : t('addon.download', { size: sizeText(status.size_mb) })}>
      <span className="st-value" data-testid={`addon-status-${status.agent}`} role={failed ? 'alert' : 'status'}>
        {rowText(status)}
      </span>
      {installed ? (
        <Btn small onClick={onRemove} aria-label={t('addon.removeAria', { label: status.label })}>
          {t('settings.remove')}
        </Btn>
      ) : (
        !installing && (
          <Btn small primary onClick={onInstall} aria-label={t(failed ? 'addon.retryAria' : 'addon.installAria', { label: status.label })}>
            {failed ? t('teamPage.tryAgain') : t('agentPage.install')}
          </Btn>
        )
      )}
      {error && <Note role="alert">{error}</Note>}
    </SettingRow>
  );
}

export function ChatAddonRows({ api = tauriAcpAddonApi }: { api?: AcpAddonApi }) {
  const t = useT();
  const addons = useAcpAddons(api);
  const list = Object.values(addons.byAgent);
  // Not in Labs, or outside the desktop app, or an older build: nothing to show.
  if (!addons.labsEnabled || list.length === 0) return null;
  return (
    <>
      <Note>{t('addon.note')}</Note>
      {list.map((status) => (
        <AddonRow key={status.agent} status={status} error={addons.removeErrors[status.agent]} onInstall={() => void addons.install(status.agent)} onRemove={() => void addons.remove(status.agent)} />
      ))}
    </>
  );
}
