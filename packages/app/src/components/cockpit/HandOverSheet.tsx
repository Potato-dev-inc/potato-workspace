// "Hand this to Claude 2?" Three buttons: Hand over now, Hand over when it finishes, Cancel. Mounted once in the cockpit; it
// shows whenever `askHandOver` (lib/task-handover) has an open question, from the sidebar's drop or the "Hand to..." menus.
// After a choice the undo bar offers to take it back: "now" is handed back the same way, "when it finishes" is cancelled.
import { useId, useState } from 'react';
import { useT } from '../../i18n';
import { announce } from '../dnd/announce';
import { errorSentence } from '../../lib/sayError';
import { showUndo } from '../../lib/undo-bar';
import { namesOf, closeHandOver, tauriHandOverApi, useHandOverRequest, type HandMode, type HandOverApi, type HandRequest } from '../../lib/task-handover';
import { followHandOver, minionTaskId } from '../../lib/task-sidebar';
import { Sheet } from './Sheet';

export function HandOverSheet({ api = tauriHandOverApi, notify }: { api?: HandOverApi; notify: (text: string) => void }) {
  const t = useT();
  const req = useHandOverRequest();
  const [busy, setBusy] = useState(false);
  const titleId = useId();
  if (!req) return null;

  const run = async (r: HandRequest, mode: HandMode) => {
    setBusy(true);
    try {
      const said = await api.handOver(r.taskPane, r.toId, mode, namesOf(r));
      closeHandOver();
      if (said) notify(said);
      if (mode === 'now') followHandOver(minionTaskId(r.taskPane), r.toId);
      announce(t(mode === 'now' ? 'taskdrag.done.now' : 'taskdrag.done.later', { task: r.taskName, name: r.toName }));
      showUndo({
        text: t(mode === 'now' ? 'taskdrag.done.now' : 'taskdrag.done.later', { task: r.taskName, name: r.toName }),
        failText: t('taskdrag.failed'),
        undo:
          mode === 'now'
            ? async () => {
                await api.handOver(r.taskPane, r.fromId, 'now', namesOf({ ...r, fromId: r.toId, fromName: r.toName, toId: r.fromId, toName: r.fromName }));
                followHandOver(minionTaskId(r.taskPane), r.fromId);
              }
            : async () => {
                await api.cancel(r.taskPane);
              },
      });
    } catch (e) {
      closeHandOver();
      notify(errorSentence(e, t('taskdrag.failed')));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet labelledBy={titleId} onClose={busy ? undefined : closeHandOver} role="dialog">
      <h2 id={titleId} className="ck-section">
        {t('taskdrag.sheet.title', { name: req.toName })}
      </h2>
      <p className="ck-sub">{t('taskdrag.sheet.lead', { task: req.taskName, from: req.fromName })}</p>
      <div className="tdh-choices">
        <button type="button" className="ck-btn ck-btn--primary tdh-choice" data-testid="hand-now" disabled={busy} autoFocus onClick={() => void run(req, 'now')}>
          <span className="tdh-choice-name">{t('taskdrag.sheet.now')}</span>
          <span className="tdh-choice-hint">{t('taskdrag.sheet.nowHint', { from: req.fromName, to: req.toName })}</span>
        </button>
        <button type="button" className="ck-btn tdh-choice" data-testid="hand-later" disabled={busy} onClick={() => void run(req, 'when_finished')}>
          <span className="tdh-choice-name">{t('taskdrag.sheet.later')}</span>
          <span className="tdh-choice-hint">{t('taskdrag.sheet.laterHint', { from: req.fromName, to: req.toName })}</span>
        </button>
      </div>
      <div className="ck-sheet-actions">
        <button type="button" className="ck-btn ck-btn--plain" data-testid="hand-cancel" disabled={busy} onClick={closeHandOver}>
          {t('taskdrag.sheet.cancel')}
        </button>
      </div>
    </Sheet>
  );
}
