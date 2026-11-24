// Inbox: a lend that ended on its own ("Lend ended: the lender's PC restarted") stays as a row until it is dismissed, so a
// toast that was missed can still be read. The row is mine to remove; nothing here changes the lend.
import { useState } from 'react';
import { useT } from '../../i18n';
import { whenLabel } from '../../lib/inbox-activity';
import { agentLabel, endedNotice, rowName, type Grant, type LendState } from '../../lib/lend';
import { IconLend } from '../cockpit/inbox/ActivityIcons';

const KEY = 'pm.lend.endedDismissed';
/** Rows older than this go by themselves. */
export const ENDED_ROW_MS = 3 * 24 * 3600_000;
const MAX_ROWS = 3;

const readGone = (): string[] => {
  try {
    const v: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

/** The ended lends worth a row: ended on their own (notice words exist), recent, newest first. */
export function endedRows(grants: readonly Grant[], now: number, gone: readonly string[]): Grant[] {
  const at = (g: Grant) => g.ended_ms ?? g.ends_ms;
  return grants
    .filter((g) => g.state === 'ended' && !gone.includes(g.id) && now - at(g) < ENDED_ROW_MS && endedNotice(g) !== null)
    .sort((a, b) => at(b) - at(a))
    .slice(0, MAX_ROWS);
}

export function LendEndedRows({ state, now }: { state: LendState | null; now: number }) {
  const t = useT();
  const [gone, setGone] = useState<string[]>(readGone);
  const rows = state ? endedRows(state.grants, now, gone) : [];
  if (!state || rows.length === 0) return null;
  const dismiss = (id: string) => {
    const next = [...gone, id].slice(-50);
    setGone(next);
    try {
      window.localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* no storage here: it comes back next time */
    }
  };
  return (
    <section className="ib-sec" aria-label={t('inbox.lendEnded')} data-testid="lend-ended-rows">
      <ul className="ib-rows">
        {rows.map((g) => (
          <li key={g.id} data-lend-ended={g.id}>
            <div className="ib-row">
              <span className="ib-tile ib-tile--lend" data-tone="lend">
                <IconLend />
              </span>
              <div className="ib-row-tx">
                <span className="ib-row-tt">{endedNotice(g)}</span>
                <span className="ib-row-sb">
                  {agentLabel(state, g.agent_id)} · {rowName(g)}
                </span>
              </div>
              <button type="button" className="ib-row-go ck-btn ck-btn--sm ck-btn--secondary" aria-label={t('lend.past.dismiss')} onClick={() => dismiss(g.id)}>
                ×
              </button>
              <time className="ib-when">{whenLabel(g.ended_ms ?? g.ends_ms, now)}</time>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
