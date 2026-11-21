// A terminal that runs on another PC: the same `TerminalViewport` as a terminal on this PC, fed by that PC's pane stream over the
// PC link (`usePaneRegistry(host)`). What this PC may do there is the far PC's to say; here it only decides whether typing is offered.
import { useMemo } from 'react';
import { useT } from '../../i18n';
import { usePaneRegistry, type PaneData } from '../../hooks/usePaneRegistry';
import type { Host } from '../../lib/host/host';
import { TerminalViewport } from '../TerminalViewport';
import type { RemoteRow } from './useDeviceGroups';

export function FarTerminal({ name, paneId, row, host }: { name: string; paneId: string; row: Pick<RemoteRow, 'agent' | 'status' | 'cwd'>; host: Host }) {
  const t = useT();
  const registry = usePaneRegistry(host);
  const listed = registry.panes.get(paneId);
  // The session key stays 0 so the list arriving later does not rebuild the terminal.
  const pane = useMemo<PaneData>(
    () => ({
      status: listed?.status ?? row.status,
      info: { cols: 80, rows: 24, pid: 0, last_output_at: null, cwd: row.cwd, ...listed?.info, id: paneId, agent_type: row.agent, status: listed?.status ?? row.status, created_at: 0 },
    }),
    [listed, paneId, row.agent, row.status, row.cwd],
  );
  return (
    <div className="dev-remote-term" data-testid="remote-terminal" aria-label={t('devices.remote.terminalTitle', { name })}>
      <TerminalViewport pane={pane} registry={registry} chrome={false} />
    </div>
  );
}
