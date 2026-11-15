// The phone's compact Inbox part: "Done today" (what finished since local midnight) and "Team activity" (the last three
// team events). Both are read-only: the PC answers `GET /phone/done` and `GET /team/cards` (needs `watch`). A row of
// Done today opens its chat. A PC that has no such route shows nothing here. Teammates' words are plain text.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n';
import type { BridgeClient, PhoneDoneRow, TeamCardsReply } from '../../lib/bridge-types';
import { clockTime, DONE_SHOWN, startOfDay } from '../../lib/done-today';
import { activityRows, whenLabel } from '../../lib/inbox-activity';
import { PhoneAgentTile } from './PhoneAgentTile';
import '../../styles/phone-inbox.css';

const POLL_MS = 20_000;
/** The phone shows fewer team rows than the desktop. */
export const PHONE_ACTIVITY_MAX = 3;

const num = (n: number) => n.toLocaleString('en-US');

export function PhoneInboxHome({
  bridge,
  bridgeReady,
  labels,
  onOpen,
  inDrawer = false,
}: {
  bridge: Pick<BridgeClient, 'phoneDone' | 'teamCards'>;
  bridgeReady: boolean;
  labels: ReadonlyMap<string, string>;
  onOpen: (paneId: string) => void;
  /** In the drawer the two headings take the drawer's heading style. */
  inDrawer?: boolean;
}) {
  const t = useT();
  const [done, setDone] = useState<PhoneDoneRow[] | null>(null);
  const [team, setTeam] = useState<TeamCardsReply | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [all, setAll] = useState(false);
  const alive = useRef(true);

  const load = useCallback(async () => {
    const at = Date.now();
    try {
      if (bridge.phoneDone) {
        const reply = await bridge.phoneDone(startOfDay(at));
        if (alive.current) setDone(reply.rows);
      }
    } catch {
      // An old PC or a blip: keep what is shown. The part is optional.
    }
    try {
      if (bridge.teamCards) {
        const reply = await bridge.teamCards();
        if (alive.current) setTeam(reply);
      }
    } catch {
      // Same: optional.
    }
    if (alive.current) setNow(at);
  }, [bridge]);

  useEffect(() => {
    alive.current = true;
    if (!bridgeReady) return;
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => {
      alive.current = false;
      window.clearInterval(timer);
    };
  }, [bridgeReady, load]);

  const rows = done ?? [];
  const shown = all ? rows : rows.slice(0, DONE_SHOWN);
  const events = team?.enabled ? activityRows(team.cards, [], null).slice(0, PHONE_ACTIVITY_MAX) : [];
  if (done === null && events.length === 0) return null;

  return (
    <div className="ph-ibx" data-testid="phone-inbox-home">
      {done !== null && (
        <section aria-label={t('inbox.doneToday')} data-testid="phone-done-today">
          <h2 className={`${inDrawer ? 'ph-dsec' : 'ph-sec'} ph-ibx-lab`}>
            <span>{t('inbox.doneToday')}</span>
            {rows.length > 0 && <span className="ph-ibx-n">· {rows.length}</span>}
          </h2>
          {rows.length === 0 ? (
            <p className="ph-ibx-none">{t('inbox.doneNone')}</p>
          ) : (
            <ul className="ph-ibx-list">
              {shown.map((r) => {
                const title = labels.get(r.paneId) ?? r.agent;
                return (
                  <li key={r.paneId} data-done-row={r.paneId}>
                    <button type="button" className="ph-ibx-row" onClick={() => onOpen(r.paneId)} aria-label={`${t('inbox.doneOpen')}: ${title}`}>
                      <PhoneAgentTile id={r.agent} name={r.agent} size={28} />
                      <span className="ph-ibx-tx">
                        <span className="ph-ibx-tt">{title}</span>
                        <span className="ph-ibx-sb">
                          {r.files.count > 0 ? (
                            <>
                              {t('inbox.doneFiles', { count: r.files.count })} <span className="ph-ibx-add">+{num(r.files.added)}</span>{' '}
                              <span className="ph-ibx-del">−{num(r.files.deleted)}</span>
                              {r.checks ? ` · ${r.checks}` : ''}
                            </>
                          ) : (
                            t('inbox.doneNoChanges')
                          )}
                        </span>
                      </span>
                      <time className="ph-ibx-when" dateTime={new Date(r.endedAtMs).toISOString()}>
                        {clockTime(r.endedAtMs)}
                      </time>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {rows.length > DONE_SHOWN && (
            <button type="button" className="ph-ibx-more" onClick={() => setAll((v) => !v)}>
              {all ? t('inbox.doneShowFewer') : t('inbox.doneShowAll', { n: rows.length })}
            </button>
          )}
        </section>
      )}
      {events.length > 0 && (
        <section aria-label={t('inbox.teamActivity')} data-testid="phone-team-activity">
          <h2 className={`${inDrawer ? 'ph-dsec' : 'ph-sec'} ph-ibx-lab`}>
            <span>{t('inbox.teamActivity')}</span>
          </h2>
          <ul className="ph-ibx-list">
            {events.map((r) => (
              <li key={r.id} className="ph-ibx-row ph-ibx-row--plain" data-team-activity={r.id}>
                <span className={`ph-ibx-tile ph-ibx-tile--${r.tone}`} data-tone={r.tone} aria-hidden="true" />
                <span className="ph-ibx-tx">
                  <span className="ph-ibx-tt">{r.line}</span>
                  <span className="ph-ibx-sb">{r.sub}</span>
                </span>
                <time className="ph-ibx-when" dateTime={new Date(r.atMs).toISOString()}>
                  {whenLabel(r.atMs, now)}
                </time>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
