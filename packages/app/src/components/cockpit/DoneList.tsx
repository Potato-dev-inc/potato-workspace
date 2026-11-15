// The Done list on a chat's result card: what "done" means for this project (the build passes, the tests pass, or the
// person's own lines), each with a tick, a cross or "not checked". A cross has "Fix it", which writes the problem in the
// message box. It reads what the agent already did in its last turn; it never runs anything or asks a model.
// It is one small line ("Done means: 2 checks · not checked") until there is a result or the person opens it; it shows
// nothing before there is something to check, and it can be hidden for a chat, for a project, or for good (lib/done-card.ts).
import { useMemo, useState } from 'react';
import { useT } from '../../i18n';
import { requestChatTab } from '../../lib/chatTab';
import { pushComposerInsert } from '../../lib/composer-insert';
import { hideDoneForChat, hideDoneForProject, useDoneCardAllowed } from '../../lib/done-card';
import { doneLines, evaluateDone, loadDoneMeans, saveDoneMeans, type DoneResult } from '../../lib/done-list';
import { useSessionChat } from '../../hooks/useSessionChat';
import type { ChatTurn } from '../../lib/sessionChatModel';
import { folderKey } from './history-model';
import { IconClose } from './Icons';
import '../../styles/cockpit-donelist.css';

const GLYPH = { pass: '✓', fail: '✕', unchecked: '?' } as const;

/** The turn is finished and did something worth checking: it ran a command or changed a file. */
export function worthChecking(turn: ChatTurn | undefined): boolean {
  if (!turn || !(turn.end || turn.ending)) return false;
  return turn.steps.some((s) => s.kind === 'tool' && (s.call.writes === true || /command|bash|shell|run|exec/i.test(s.call.name)));
}

export function DoneList({ paneId, cwd, rail }: { paneId: string; cwd: string; rail?: boolean }) {
  const chat = useSessionChat(paneId, true);
  const turn = chat.turns[chat.turns.length - 1];
  return <DoneListFor paneId={paneId} cwd={cwd} turn={turn} rail={rail} />;
}

/** The list for one turn (the part that is tested without a chat reader). */
export function DoneListFor({ paneId, cwd, turn, rail }: { paneId: string; cwd: string; turn: ChatTurn | undefined; /** In the right panel: one plain row (label, result), the list opens under it. */ rail?: boolean }) {
  const t = useT();
  const key = folderKey(cwd) ?? paneId;
  const [custom, setCustom] = useState<string[] | null>(() => loadDoneMeans(key));
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  // The person's own open/fold choice; until there is one, the line opens by itself once a check has a result.
  const [opened, setOpened] = useState<boolean | null>(null);
  const allowed = useDoneCardAllowed(paneId, key);
  const lines = useMemo(() => doneLines(custom, { build: t('done.build'), tests: t('done.tests') }), [custom, t]);
  const results = useMemo(() => evaluateDone(lines, turn), [lines, turn]);

  if (!allowed || (!worthChecking(turn) && !editing)) return null;
  const hasResult = results.some((r) => r.state !== 'unchecked');
  const expanded = editing || (opened ?? hasResult);
  const fails = results.filter((r) => r.state === 'fail').length;
  const passes = results.filter((r) => r.state === 'pass').length;
  const stateText =
    fails > 0 ? t('done.stateFail', { n: fails }) : passes === 0 ? t('done.stateNone') : passes === results.length ? t('done.stateAll') : t('done.stateSome', { done: passes, total: results.length });
  const checksText = results.length === 1 ? t('done.checksOne') : t('done.checks', { n: results.length });
  const closeBtn = (
    <button type="button" className="ck-done-x" aria-label={t('done.hideChat')} title={t('done.hideChat')} onClick={() => hideDoneForChat(paneId)}>
      <IconClose />
    </button>
  );

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

  if (rail && !editing) {
    const railText = fails > 0 ? t('rail.chg.checksFail', { fail: fails, total: results.length }) : passes === 0 ? t('rail.chg.checksNotRun', { checks: checksText }) : t('rail.chg.checksPass', { done: passes, total: results.length });
    const tone = fails > 0 ? 'is-bad' : passes > 0 && passes === results.length ? 'is-ok' : 'is-dim';
    return (
      <div className="rp-done" data-testid="done-list" data-state={fails > 0 ? 'fail' : tone === 'is-ok' ? 'pass' : 'none'}>
        <button type="button" className="rp-row rp-btn" aria-expanded={expanded} data-testid="done-toggle" onClick={() => setOpened(!expanded)}>
          <span className="rp-k">{t('rail.chg.doneMeans')}</span>
          <span className={`rp-v ${tone}`}>{railText}</span>
        </button>
        {expanded && (
          <ul className="rp-list">
            {results.map((r) => (
              <li key={r.line.text} className="rp-row rp-sub" data-state={r.state}>
                <span className={`rp-glyph is-${r.state}`} role="img" aria-label={wording(r)}>
                  {GLYPH[r.state]}
                </span>
                <span className="rp-name">{r.line.text}</span>
                {r.state === 'fail' && (
                  <button type="button" className="rp-mini" title={t('done.fixTip')} onClick={() => fix(r)}>
                    {t('done.fix')}
                  </button>
                )}
              </li>
            ))}
            <li className="rp-row rp-sub">
              <button type="button" className="rp-link" onClick={startEdit}>
                {t('done.edit')}
              </button>
              <button type="button" className="rp-link" data-testid="done-hide-project" onClick={() => hideDoneForProject(key)}>
                {t('done.hideProject')}
              </button>
            </li>
          </ul>
        )}
      </div>
    );
  }

  return (
    <section className={`ck-done${expanded ? '' : ' is-folded'}`} aria-label={t('done.listLabel')} data-testid="done-list">
      <div className="ck-done-head">
        <button type="button" className="ck-done-line-btn" aria-expanded={expanded} title={expanded ? t('done.hideChecks') : t('done.show')} onClick={() => setOpened(!expanded)} data-testid="done-toggle">
          <span className="ck-done-chev" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
          {expanded ? <span className="ck-caption">{t('done.title')}</span> : <span className="ck-done-summary">{t('done.collapsed', { checks: checksText, state: stateText })}</span>}
        </button>
        <span className="ck-head-gap" aria-hidden="true" />
        {expanded && !editing && (
          <>
            <button type="button" className="ck-btn ck-btn--sm ck-btn--plain" onClick={startEdit}>
              {t('done.edit')}
            </button>
            <button type="button" className="ck-btn ck-btn--sm ck-btn--plain" data-testid="done-hide-project" onClick={() => hideDoneForProject(key)}>
              {t('done.hideProject')}
            </button>
          </>
        )}
        {closeBtn}
      </div>
      {!expanded ? null : editing ? (
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
