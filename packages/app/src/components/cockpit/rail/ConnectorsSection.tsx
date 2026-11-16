// Connectors: the tool servers this chat uses. One row ("5 connected" and "All working" or "1 to reconnect"); a click
// opens the list. The "Tools are out of date" notice from the tool-list check shows here as a row with Reconnect.
import { useState } from 'react';
import { useT } from '../../../i18n';
import { openSettingsAt } from '../../../lib/openSettingsAt';
import type { PaneConnector } from './usePaneConnectors';
import { RailSection } from './RailSection';

export function ConnectorsSection({
  connectors,
  outOfDate,
  reconnecting,
  onReconnect,
}: {
  connectors: readonly PaneConnector[];
  /** This chat's tool list is not the app's: show the row with a Reconnect button. */
  outOfDate: boolean;
  reconnecting: boolean;
  onReconnect: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const bad = connectors.filter((c) => !c.ok).length + (outOfDate ? 1 : 0);
  const n = connectors.length;
  const summary = n === 0 && !outOfDate ? t('rail.con.none') : bad > 0 ? t('rail.con.summaryBad', { n, bad }) : t('rail.con.summary', { n });
  return (
    <RailSection id="con" title={t('rail.con.title')} summary={summary}>
      {n === 0 && !outOfDate ? (
        <div className="rp-row is-empty">
          <span className="rp-name">{t('rail.con.none')}</span>
          <button type="button" className="rp-link" onClick={() => openSettingsAt('advanced', 'toolbelt')}>
            {t('rail.con.add')}
          </button>
        </div>
      ) : (
        <>
          {n > 0 && (
            <button type="button" className="rp-row rp-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
              <span className="rp-k">{t('rail.con.connected', { n })}</span>
              <span className={`rp-v ${bad > 0 ? 'is-warn' : 'is-dim'}`}>{bad > 0 ? t('rail.con.toReconnect', { n: bad }) : t('rail.con.allWorking')}</span>
            </button>
          )}
          {open &&
            connectors.map((c) => (
              <div key={c.name} className="rp-row rp-sub">
                <span className={`rp-cdot ${c.ok ? 'is-ok' : 'is-off'}`} aria-hidden="true" />
                <span className="rp-name">{c.name}</span>
                <span className="rp-v is-dim">{t('rail.con.tools', { count: c.tools, n: c.tools })}</span>
              </div>
            ))}
          {outOfDate && (
            <div className="rp-row" data-testid="rail-tools-stale">
              <span className="rp-cdot is-off" aria-hidden="true" />
              <span className="rp-name">{t('rail.con.outOfDate')}</span>
              <button type="button" className="rp-mini" disabled={reconnecting} onClick={onReconnect}>
                {reconnecting ? t('rail.con.reconnecting') : t('rail.con.reconnect')}
              </button>
            </div>
          )}
        </>
      )}
    </RailSection>
  );
}
