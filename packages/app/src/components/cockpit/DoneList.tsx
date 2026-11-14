// The Done list on a chat's result card: what "done" means for this project (the build passes, the tests pass, or the
// person's own lines), each with a tick, a cross or "not checked". A cross has "Fix it", which writes the problem in the
// message box. It reads what the agent already did in its last turn; it never runs anything or asks a model.
import { useMemo, useState } from 'react';
import { useT } from '../../i18n';
import { requestChatTab } from '../../lib/chatTab';
import { pushComposerInsert } from '../../lib/composer-insert';
import { doneLines, evaluateDone, loadDoneMeans, saveDoneMeans, type DoneResult } from '../../lib/done-list';
import { useSessionChat } from '../../hooks/useSessionChat';
import type { ChatTurn } from '../../lib/sessionChatModel';
import { folderKey } from './history-model';
import '../../styles/cockpit-donelist.css';

const GLYPH = { pass: '✓', fail: '✕', unchecked: '?' } as const;

/** The turn is finished and did something worth checking: it ran a command or changed a file. */
export function worthChecking(turn: ChatTurn | undefined): boolean {
  if (!turn || !(turn.end || turn.ending)) return false;
  return turn.steps.some((s) => s.kind === 'tool' && (s.call.writes === true || /command|bash|shell|run|exec/i.test(s.call.name)));
}

export function DoneList({ paneId, cwd }: { paneId: string; cwd: string }) {
  const chat = useSessionChat(paneId, true);
  const turn = chat.turns[chat.turns.length - 1];
  return <DoneListFor paneId={paneId} cwd={cwd} turn={turn} />;
}

/** The list for one turn (the part that is tested without a chat reader). */
export function DoneListFor({ paneId, cwd, turn }: { paneId: string; cwd: string; turn: ChatTurn | undefined }) {
  const t = useT();
  const key = folderKey(cwd) ?? paneId;
  const [custom, setCustom] = useState<string[] | null>(() => loadDoneMeans(key));
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const lines = useMemo(() => doneLines(custom, { build: t('done.build'), tests: t('done.tests') }), [custom, t]);
  const results = useMemo(() => evaluateDone(lines, turn), [lines, turn]);

  if (!worthChecking(turn) && !editing) return null;

  const wording = (r: DoneResult) => (r.state === 'pass' ? t('done.pass') : r.state === 'fail' ? t('done.fail') : t('done.unchecked'));
  const fix = (r: DoneResult) => {
    pushComposerInsert(paneId, t('done.fixText', { line: r.line.text, detail: r.detail ? ` (${r.detail})` : '' }));
    requestChatTab(paneId);
  };
  const startEdit = () => {
    setDraft(lines.map((l) => l.text).join('\n'));
    setEditing(true);
  };
  const save = () => {
    const next = draft.split('\n').map((x) => x.trim()).filter(Boolean);
    saveDoneMeans(key, next);
    setCustom(next.length > 0 ? next : null);
    setEditing(false);
  };

  return (
    <section className="ck-done" aria-label={t('done.listLabel')} data-testid="done-list">
      <div className="ck-done-head">
        <span className="ck-caption">{t('done.title')}</span>
        {!editing && (
          <button type="button" className="ck-btn ck-btn--sm ck-btn--plain" onClick={startEdit}>
            {t('done.edit')}
          </button>
        )}
      </div>
      {editing ? (
        <div className="ck-done-edit">
          <label className="ck-sub" htmlFor={`done-edit-${paneId}`}>
            {t('done.editLabel')}
          </label>
          <textarea
            id={`done-edit-${paneId}`}
            className="ck-done-text"
            rows={4}
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setEditing(false)}
          />
          <div className="ck-done-actions">
            <button type="button" className="ck-btn ck-btn--sm ck-btn--primary" onClick={save}>
              {t('done.save')}
            </button>
            <button type="button" className="ck-btn ck-btn--sm ck-btn--secondary" onClick={() => setEditing(false)}>
              {t('done.cancel')}
            </button>
            <button type="button" className="ck-btn ck-btn--sm ck-btn--plain" onClick={() => {
                saveDoneMeans(key, null);
                setCustom(null);
                setEditing(false);
              }}>
              {t('done.reset')}
            </button>
          </div>
        </div>
      ) : (
        <ul className="ck-done-list">
          {results.map((r) => (
            <li key={r.line.text} className="ck-done-row" data-state={r.state}>
              <span className="ck-done-glyph" role="img" aria-label={wording(r)}>
                {GLYPH[r.state]}
              </span>
              <span className="ck-done-line">{r.line.text}</span>
              <span className="ck-done-note">{r.state === 'fail' ? r.detail : r.state === 'unchecked' ? t('done.unchecked') : ''}</span>
              {r.state === 'fail' && (
                <button type="button" className="ck-btn ck-btn--sm ck-btn--secondary" title={t('done.fixTip')} onClick={() => fix(r)}>
                  {t('done.fix')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
