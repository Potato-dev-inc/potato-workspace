// "Continue where you left off": one card on the start page when chats that were open last time did not come back.
// Reopen (all, or the ticked ones) brings them back and restores the split they had. A chat that cannot be reopened gets
// a row with "Start fresh with a short brief", which fills the message box; it is never started silently.
import { useMemo, useState } from 'react';
import { folderName, useClosedChats, type ClosedChat, type ClosedChatsApi } from '../../../lib/closedChats';
import { useT, t as tr } from '../../../i18n';
import type { SplitMemory } from '../split-memory';
import { dayWordOf, dismissChats, pendingChats, readDismissed, worthOffering, type YesterdayChat, type YesterdaySnapshot } from '../yesterday-memory';

export interface ContinueYesterdayProps {
  /** What the last run left (yesterday-memory.ts previousRun). */
  previous: YesterdaySnapshot | null;
  api: ClosedChatsApi;
  /** The panes open now: a chat already open is not offered. */
  openIds: readonly string[];
  /** Chats came back: the ids in tab order, and the split they had when it was whole (or null). */
  onReopened: (paneIds: string[], split: SplitMemory | null) => void;
  /** Fills the message box with a short brief for a chat that cannot be reopened. */
  onFresh: (text: string) => void;
  /** Current time, for the "Today" / "Yesterday" words. */
  now?: number;
}

/** The brief a fresh start gets. Plain words; the person can edit it before sending. */
export function freshBrief(chat: YesterdayChat, name: string): string {
  return tr('newAgent.freshBrief', { title: name, folder: folderName(chat.cwd) || chat.cwd });
}

export function ContinueCard({ previous, api, openIds, onReopened, onFresh, now = Date.now() }: ContinueYesterdayProps) {
  const t = useT();
  const { chats: closed, reload } = useClosedChats(api, openIds.join('|'));
  const [unticked, setUnticked] = useState<Set<string>>(new Set());
  const [failed, setFailed] = useState<Set<string>>(new Set());
  const [done, setDone] = useState<Set<string>>(new Set());
  const [dismissed, setDismissed] = useState<Set<string>>(() => readDismissed());
  const [busy, setBusy] = useState(false);

  const openSet = useMemo(() => new Set(openIds), [openIds]);
  const closedById = useMemo(() => new Map<string, ClosedChat>(closed.map((c) => [c.id, c])), [closed]);
  const realTitle = (chat: YesterdayChat): string | null => closedById.get(chat.id)?.title?.trim() || chat.title?.trim() || null;
  const rows = useMemo(
    () => worthOffering(pendingChats(previous, openSet, new Set(closedById.keys())).filter((c) => !done.has(c.id)), dismissed, (c) => closedById.get(c.id)?.title?.trim() || c.title?.trim() || null),
    [previous, openSet, closedById, done, dismissed],
  );
  if (!previous || rows.length === 0) return null;

  const nameOf = (chat: YesterdayChat): string => realTitle(chat) ?? t('newAgent.continueUntitled');
  const hide = () => {
    dismissChats(rows.map((c) => c.id));
    setDismissed(readDismissed());
  };
  const ticked = rows.filter((c) => !unticked.has(c.id) && !failed.has(c.id));
  const allTicked = ticked.length === rows.filter((c) => !failed.has(c.id)).length;
  const dayWord = dayWordOf(previous.savedAt, now);
  const day = dayWord === 'today' ? t('newAgent.dayToday') : dayWord === 'yesterday' ? t('newAgent.dayYesterday') : new Date(previous.savedAt).toLocaleDateString([], { month: 'short', day: 'numeric' });
  const time = new Date(previous.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const reopen = async () => {
    setBusy(true);
    const opened: string[] = [];
    const nowFailed = new Set(failed);
    const nowDone = new Set(done);
    for (const chat of ticked) {
      try {
        const paneId = await api.reopen(chat.id);
        opened.push(paneId);
        nowDone.add(chat.id);
      } catch {
        nowFailed.add(chat.id);
      }
    }
    dismissChats(opened.length > 0 ? [...nowDone] : []);
    setFailed(nowFailed);
    setDone(nowDone);
    setBusy(false);
    reload();
    if (opened.length > 0) {
      const split = previous.split && opened.includes(previous.split.left) && opened.includes(previous.split.right) ? previous.split : null;
      onReopened(opened, split);
    }
  };

  return (
    <section className="ck-na-hc ck-na-continue" aria-label={t('newAgent.continueTitle')} data-testid="continue-card">
      <header className="ck-na-hc-head">
        <h2 className="ck-na-hc-title">{t('newAgent.continueTitle')}</h2>
        <span className="ck-na-line-side">{t('newAgent.continueWhen', { day, time })}</span>
      </header>
      <ul className="ck-na-list">
        {rows.map((chat) => {
          const isFailed = failed.has(chat.id);
          const name = nameOf(chat);
          if (isFailed) {
            return (
              <li key={chat.id} className="ck-na-continue-row" data-testid="continue-failed-row">
                <span className="ck-na-line-main">{t('newAgent.continueFailed', { name })}</span>
                <button
                  type="button"
                  className="ck-btn ck-btn--secondary ck-btn--sm"
                  onClick={() => {
                    onFresh(freshBrief(chat, name));
                    dismissChats([chat.id]);
                    setDone((cur) => new Set(cur).add(chat.id));
                  }}
                >
                  {t('newAgent.continueFresh')}
                </button>
              </li>
            );
          }
          return (
            <li key={chat.id}>
              <label className="ck-na-continue-pick">
                <input
                  type="checkbox"
                  aria-label={t('newAgent.continueTick', { name })}
                  checked={!unticked.has(chat.id)}
                  disabled={busy}
                  onChange={() =>
                    setUnticked((cur) => {
                      const next = new Set(cur);
                      if (next.has(chat.id)) next.delete(chat.id);
                      else next.add(chat.id);
                      return next;
                    })
                  }
                />
                <span className="ck-na-continue-name">{name}</span>
                <span className="ck-na-continue-project">{folderName(chat.cwd) || closedById.get(chat.id)?.label || ''}</span>
              </label>
            </li>
          );
        })}
      </ul>
      <div className="ck-na-foot ck-na-continue-foot">
        {ticked.length > 0 && (
          <button type="button" className="ck-btn ck-btn--primary ck-btn--sm" disabled={busy} onClick={() => void reopen()}>
            {allTicked ? t('newAgent.continueReopenAll', { count: ticked.length }) : t('newAgent.continueReopenPicked', { count: ticked.length })}
          </button>
        )}
        <button type="button" className="ck-na-link" onClick={hide}>
          {t('newAgent.continueHide')}
        </button>
      </div>
    </section>
  );
}
