// Settings > Bridge > Connection check: agents whose tools are out of date, each with Reconnect. It reads the same
// list as the banner above a chat. Nothing shows while every agent has the app's tool list.
import { useEffect, useState } from 'react';
import { useT } from '../../../../i18n';
import { useToolsDrift } from '../../../../hooks/useToolsDrift';
import { tauri } from '../../../../lib/tauri';
import { Btn, Note } from '../../settings-ui';

export function ToolsDriftList({ pollMs }: { pollMs?: number }) {
  const t = useT();
  const { rows, busy, failed, reconnect } = useToolsDrift(pollMs);
  const [names, setNames] = useState<Record<string, string>>({});

  const wanted = rows.map((row) => row.paneId).join(',');
  useEffect(() => {
    if (!wanted) return;
    let alive = true;
    tauri.listPanes().then(
      (panes) => {
        if (!alive) return;
        setNames(Object.fromEntries(panes.map((pane) => [pane.id, pane.title || pane.agent_type])));
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [wanted]);

  if (rows.length === 0) return null;
  return (
    <div data-tools-stale-list="true" role="status" className="mt-2">
      <Note>{t('tools.stale.title')}</Note>
      {rows.map((row) => {
        const key = row.paneId ?? '';
        const label = row.paneId ? (names[row.paneId] ?? t('tools.stale.anAgent')) : t('tools.stale.aProgram');
        return (
          <div key={key || 'program'} className="flex flex-wrap items-center gap-3 py-1" data-tools-stale-row={key || 'program'}>
            <span>{label}</span>
            {row.paneId && row.canReconnect ? (
              <Btn small disabled={busy === row.paneId} onClick={() => void reconnect(row.paneId as string, t('tools.stale.failed'))}>
                {busy === row.paneId ? t('tools.stale.working') : t('tools.stale.reconnect')}
              </Btn>
            ) : (
              <Note>{t('tools.stale.reopen')}</Note>
            )}
            {failed[key] && <Note role="alert">{failed[key]}</Note>}
          </div>
        );
      })}
    </div>
  );
}
