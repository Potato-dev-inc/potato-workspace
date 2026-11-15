// "Tools are out of date — Reconnect": one dense row above a chat whose agent started with another tool list than
// the app's (an older MCP program), so a call like show_artifact can come back "unknown tool". Reconnect restarts
// that agent; the conversation stays. Shown only for this pane's own connection.
import { useT } from '../../i18n';
import { useToolsDrift } from '../../hooks/useToolsDrift';

export function ToolsOutOfDateBanner({ paneId, pollMs }: { paneId: string; pollMs?: number }) {
  const t = useT();
  const { rows, busy, failed, reconnect } = useToolsDrift(pollMs);
  const mine = rows.find((row) => row.paneId === paneId);
  if (!mine) return null;
  const working = busy === paneId;
  const error = failed[paneId];
  return (
    <div
      className="ck-chat-note ck-tools-stale"
      role="status"
      data-tools-stale="true"
      style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}
    >
      <span>{t('tools.stale.title')}</span>
      {mine.canReconnect ? (
        <button type="button" className="ck-btn ck-btn--plain" disabled={working} onClick={() => void reconnect(paneId, t('tools.stale.failed'))}>
          {working ? t('tools.stale.working') : t('tools.stale.reconnect')}
        </button>
      ) : (
        <span>{t('tools.stale.reopen')}</span>
      )}
      {error && <span role="alert">{error}</span>}
    </div>
  );
}
