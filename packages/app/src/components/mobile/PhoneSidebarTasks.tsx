// "Tasks" in the phone drawer: the background tasks the person put in the sidebar on the PC (`GET /phone/tasks`, needs `watch`),
// in the same place: under their agent, or on their own with a quiet "Alpha" line. Read only; nothing is dragged on the phone, and
// moving a row is done on the PC. Nothing shows when there are none, or when the PC does not have the route.
import { useEffect, useState } from 'react';
import { useT } from '../../i18n';
import type { BridgeClient, PhoneTaskRow } from '../../lib/bridge-types';

export function PhoneSidebarTasks({ bridge, open, agentName }: { bridge: Pick<BridgeClient, 'phoneTasks'>; open: boolean; agentName: (paneId: string) => string }) {
  const t = useT();
  const [rows, setRows] = useState<PhoneTaskRow[]>([]);
  useEffect(() => {
    if (!open || !bridge.phoneTasks) return;
    let live = true;
    void bridge
      .phoneTasks()
      .then((reply) => {
        if (live) setRows(reply.rows);
      })
      .catch(() => {
        // Optional: an old PC or a blip shows nothing.
      });
    return () => {
      live = false;
    };
  }, [bridge, open]);
  if (rows.length === 0) return null;
  const stateWord = (status: string) => (status === 'running' ? t('taskdrag.phone.running') : status === 'waiting_input' ? t('taskdrag.phone.waiting') : t('taskdrag.phone.done'));
  return (
    <section aria-label={t('taskdrag.phone.title')} data-testid="drawer-tasks">
      <h2 className="ph-dsec">{t('taskdrag.phone.title')}</h2>
      <ul className="ph-dlist">
        {rows.map((row) => (
          <li key={row.taskId}>
            <div className="ph-drow ph-drow--static" data-task-id={row.taskId} data-under={row.under ?? ''}>
              <span className="ph-drow-text">
                <span className="ph-drow-title">{row.name}</span>
                <span className="ph-drow-state">
                  {[t(row.kind === 'minion' ? 'taskdrag.tag.minion' : 'taskdrag.tag.command'), stateWord(row.status), row.under ? agentName(row.under) : t('taskdrag.row.ownerLine', { name: agentName(row.owner) })].join(' · ')}
                </span>
              </span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
