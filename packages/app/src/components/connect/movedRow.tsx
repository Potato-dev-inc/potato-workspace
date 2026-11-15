// An old Settings row whose content now lives on a Connect tab. In the cockpit the row is a one-line link to that
// tab; in the separate Settings window (no Connect page there) it keeps showing its own content, so nothing is lost.
import { useT } from '../../i18n';
import { connectPageAvailable, openConnect, type ConnectTab } from '../../lib/openConnect';
import type { RowDef } from '../settings/model';
import '../../styles/connect.css';

const MOVED_KEY = {
  phone: 'connect.moved.phone',
  pcs: 'connect.moved.pcs',
  team: 'connect.moved.team',
  lending: 'connect.moved.lending',
} as const;

export function ConnectLink({ tab }: { tab: ConnectTab }) {
  const t = useT();
  return (
    <div className="cn-moved" data-testid={`connect-link-${tab}`}>
      <span>{t(MOVED_KEY[tab])}</span>
      <button type="button" className="cn-btn" onClick={() => openConnect(tab)}>
        {t('connect.moved.open')}
      </button>
    </div>
  );
}

/** The rows named in `ids` show a link to the Connect `tab` in the cockpit and their own content elsewhere. */
export function movedToConnect(rows: RowDef[], ids: readonly string[], tab: ConnectTab): RowDef[] {
  return rows.map((row) => (ids.includes(row.id) ? { ...row, render: (env) => (connectPageAvailable() ? <ConnectLink tab={tab} /> : row.render(env)) } : row));
}
