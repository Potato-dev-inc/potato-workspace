// The quiet line at the bottom of the sidebar for warm agents: helpers that were removed from their agent and are still running
// ("2 warm"). Folded by default; it opens to a short list. Each row has its own menu (Make standby for…, Close).
import { useState, type ReactNode } from 'react';
import { useT } from '../../i18n';
import type { StandbyRow } from './standby-rows';
import '../../styles/standby-rows.css';

export function SidebarWarmLine({ rows, renderRow }: { rows: readonly StandbyRow[]; renderRow: (row: StandbyRow) => ReactNode }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  if (rows.length === 0) return null;
  return (
    <div className="ck-sb-warm" role="group" aria-label={t('standby.warmAria')} data-testid="standby-warm">
      <button type="button" className="ck-sb-warm-line" aria-expanded={open} onClick={() => setOpen((v) => !v)} title={t('standby.warmHelp')}>
        <span className="ck-sb-warm-count">{t('standby.warmLine', { count: rows.length })}</span>
        <span className={`ck-helper-caret${open ? ' is-open' : ''}`} aria-hidden="true" />
      </button>
      {open && <div className="ck-sb-warm-list">{rows.map(renderRow)}</div>}
    </div>
  );
}
