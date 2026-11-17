// The second line of a sidebar row for a chat that is working: what it does right now (the newest tool that has not
// ended), or "Thinking…" while no tool runs. Falls back to the usual line when the chat's state is not known yet.
import { useAcpChatState } from '../../hooks/useAcpChatState';
import { useT } from '../../i18n';
import type { AcpChatApi } from '../../lib/acpChat';

export function RowDoing({ paneId, api, fallback }: { paneId: string; api: AcpChatApi; fallback: string }) {
  const t = useT();
  const state = useAcpChatState(paneId, true, api);
  const doing = state?.doing?.trim();
  const text = doing || (state ? t('sidebar.thinking') : fallback);
  return (
    <span className="ck-row-sub" data-testid="row-doing" aria-live="off">
      {text}
    </span>
  );
}
