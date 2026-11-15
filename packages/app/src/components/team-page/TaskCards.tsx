// The two cards of the Tasks tab. A teammate's words (title, text, summary, note, repo name, errors) are untrusted:
// they are always React text nodes (never HTML or Markdown), the text sits in a quote, and nothing runs on arrival.
import { useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n';
import { durationWords } from '../../lib/lend';
import { errorSentence } from '../../lib/sayError';
import { requestNewAgent } from '../../lib/newAgentRequest';
import { setNewAgentDraft } from '../../lib/team-pass-bridge';
import type { RecvTask, SentTask, TeamTasksApi } from '../../lib/team-tasks';
import { RepoRiskBox } from './PassTaskSheet';
import { pickFolder as defaultPick, type FolderPicker } from './pickFolder';
import { acceptRepoReason, CLAMP_CHARS, canTakeBack, comesWith, lendOffered, NOTE_MAX, recvActions, sentChip, sentRepoLine } from './tasks-model';

const ago = (ms: number, now: number, t: ReturnType<typeof useT>): string => {
  const min = Math.max(0, Math.round((now - ms) / 60_000));
  if (min < 1) return t('teamHub.tasks.ago.now');
  if (min < 60) return t('teamHub.tasks.ago.min', { n: min });
  const h = Math.round(min / 60);
  if (h < 24) return t('teamHub.tasks.ago.hour', { n: h });
  return t('teamHub.tasks.ago.day', { n: Math.round(h / 24) });
};

/** The words of a teammate, in a quote, as plain text. Long ones fold behind "Read all". */
export function Quote({ text, testId }: { text: string; testId?: string }) {
  const t = useT();
  const [all, setAll] = useState(false);
  const long = text.length > CLAMP_CHARS;
  const shown = long && !all ? `${text.slice(0, CLAMP_CHARS)}…` : text;
  return (
    <>
      <blockquote className="tpg-quote" data-testid={testId}>
        {shown}
      </blockquote>
      {long && (
        <button type="button" className="tpg-link-btn" onClick={() => setAll(!all)}>
          {all ? t('teamHub.tasks.readLess') : t('teamHub.tasks.readAll')}
        </button>
      )}
    </>
  );
}

/** What "Start…" leaves for the New agent page: the words only. The person reads it and presses Send. */
export function draftOf(task: Pick<RecvTask, 'title' | 'text' | 'summary' | 'fromName' | 'unpacked'>): { text: string; folder: string | null; from: string } {
  const parts = [task.title.trim(), task.text];
  if (task.summary.trim()) parts.push(task.summary.trim());
  return { text: parts.filter((p) => p !== '').join('\n\n'), folder: task.unpacked, from: task.fromName };
}

type Panel = null | 'accept' | 'done';

export function RecvCard({
  task,
  api,
  now,
  handoverOn,
  lendOn,
  onChanged,
  pick = defaultPick,
}: {
  task: RecvTask;
  api: TeamTasksApi;
  now: number;
  handoverOn: boolean;
  lendOn: boolean;
  onChanged: () => void;
  pick?: FolderPicker;
}) {
  const t = useT();
  const [panel, setPanel] = useState<Panel>(null);
  const [usage, setUsage] = useState<'theirs' | 'lent'>('theirs');
  const [wantRepo, setWantRepo] = useState(false);
  const [understood, setUnderstood] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // First time it is on screen as new: tell the sender it was seen. Once per task.
  const told = useRef<string | null>(null);
  useEffect(() => {
    if (task.state !== 'new' || told.current === task.id) return;
    told.current = task.id;
    void api
      .seen(task.id)
      .then(onChanged)
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id, task.state]);

  const run = async (what: () => Promise<unknown>, after?: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await what();
      after?.();
      onChanged();
    } catch (e) {
      setError(errorSentence(e));
    } finally {
      setBusy(false);
    }
  };

  const start = () => {
    setError(null);
    setNewAgentDraft(draftOf(task));
    if (!requestNewAgent()) {
      setError(t('teamHub.tasks.startNoCockpit'));
      return;
    }
    void run(() => api.started(task.id));
  };

  const getRepo = async () => {
    const parent = await pick(null);
    if (!parent) return;
    await run(async () => {
      const made = await api.unpack(task.id, parent);
      setMessage(t('teamHub.tasks.repo.unpacked', { path: made }));
    });
  };

  const actions = recvActions(task);
  const withLine = comesWith(task, lendOn);
  const closed = task.state === 'done' || task.state === 'declined' || task.state === 'withdrawn';
  const quoteOf = task.state === 'withdrawn';

  if (closed) {
    const word = task.state === 'done' ? t('teamHub.tasks.closed.done') : task.state === 'declined' ? t('teamHub.tasks.closed.declined') : t('teamHub.tasks.closed.withdrawn', { name: task.fromName });
    return (
      <div className="tpg-task tpg-task--closed" data-testid={`task-${task.id}`} data-state={task.state}>
        <span className="tpg-task-closed-line">
          <span className="tpg-chip">{word}</span> <span className="tpg-task-title">{quoteOf ? null : task.title}</span>
        </span>
      </div>
    );
  }

  const lentShown = lendOffered(task, lendOn);
  const repoBlock = task.repo && (
    <div className="tpg-repo" data-testid="recv-repo">
      {task.repoState === 'receiving' && (
        <p className="tpg-sub" role="status">
          {t('teamHub.tasks.repo.receiving', { got: task.repoGot, total: task.repo.chunks })}
        </p>
      )}
      {task.repoState === 'ready' && (
        <button type="button" className="ck-btn ck-btn--secondary" disabled={busy} onClick={() => void getRepo()}>
          {t('teamHub.tasks.repo.get')}
        </button>
      )}
      {task.repoState === 'unpacked' && task.unpacked && (
        <p className="tpg-sub" data-testid="recv-unpacked">
          {t('teamHub.tasks.repo.unpacked', { path: task.unpacked })}
        </p>
      )}
      {task.repoState === 'failed' && <p className="tpg-error">{task.repoError || t('teamHub.tasks.repo.failed')}</p>}
    </div>
  );

  return (
    <div className="tpg-task" data-testid={`task-${task.id}`} data-state={task.state}>
      <div className="tpg-task-head">
        <strong className="tpg-name">{t('teamHub.tasks.passedYou', { name: task.fromName })}</strong>
        <span className="tpg-sub">{ago(task.atMs, now, t)}</span>
      </div>
      {task.risk && (
        <p className="tpg-risk-line" role="note" data-testid="task-risk">
          {t('teamHub.tasks.risk', { risk: task.risk })}
        </p>
      )}
      <p className="tpg-task-title" data-testid="task-title">
        {task.title}
      </p>
      <Quote text={task.text} testId="task-text" />
      {task.summary && (
        <>
          <p className="tpg-sub">{t('teamHub.tasks.summaryOf')}</p>
          <Quote text={task.summary} testId="task-summary" />
        </>
      )}
      {withLine && (
        <p className="tpg-sub" data-testid="task-with">
          {t('teamHub.tasks.with', { what: withLine })}
        </p>
      )}
      {repoBlock}
      {task.lendError && (
        <p className="tpg-error" role="alert" data-testid="task-lend-error">
          {task.lendError}{' '}
          <button
            type="button"
            className="ck-btn ck-btn--plain"
            disabled={busy}
            onClick={() => void run(() => api.accept(task.id, { usage: 'theirs', wantRepo: task.repoState !== 'none' && task.repoState !== 'offered', understood: true }))}
          >
            {t('teamHub.tasks.useMine')}
          </button>
        </p>
      )}

      {panel === 'accept' && (
        <div className="tpg-panel-in" data-testid="accept-panel">
          <fieldset className="tpg-radios">
            <label className="tpg-radio">
              <input type="radio" name={`use-${task.id}`} checked={usage === 'theirs'} onChange={() => setUsage('theirs')} data-testid="accept-own" />
              <span>{t('teamHub.tasks.accept.own')}</span>
            </label>
            {lentShown && task.lend && (
              <label className="tpg-radio">
                <input type="radio" name={`use-${task.id}`} checked={usage === 'lent'} onChange={() => setUsage('lent')} data-testid="accept-lent" />
                <span>{t('teamHub.tasks.accept.lent', { name: task.fromName, profile: task.lend.profileName, time: durationWords(task.lend.secs) })}</span>
              </label>
            )}
          </fieldset>
          {task.repo && (
            <>
              <label className="tpg-tick">
                <input type="checkbox" checked={wantRepo && handoverOn} disabled={!handoverOn} onChange={(e) => setWantRepo(e.target.checked)} data-testid="accept-repo" />
                <span>{t('teamHub.tasks.accept.repo')}</span>
              </label>
              {!handoverOn && <small className="tpg-why">{acceptRepoReason(handoverOn)}</small>}
              {wantRepo && handoverOn && (
                <RepoRiskBox head={t('teamHub.tasks.accept.riskHead')} lines={[t('teamHub.tasks.accept.risk1'), t('teamHub.tasks.accept.risk2')]} tick={t('teamHub.pass.risk.tick')} checked={understood} onChange={setUnderstood} />
              )}
            </>
          )}
          <div className="tpg-actions">
            <button
              type="button"
              className="ck-btn ck-btn--primary"
              disabled={busy || (wantRepo && handoverOn && !understood)}
              data-testid="accept-go"
              onClick={() => void run(() => api.accept(task.id, { usage: lentShown ? usage : 'theirs', wantRepo: wantRepo && handoverOn, understood }), () => setPanel(null))}
            >
              {t('teamHub.tasks.accept.go')}
            </button>
            <button type="button" className="ck-btn ck-btn--plain" onClick={() => setPanel(null)}>
              {t('teamHub.tasks.cancel')}
            </button>
          </div>
        </div>
      )}

      {panel === 'done' && (
        <div className="tpg-panel-in" data-testid="done-panel">
          <label className="tpg-field">
            <span>{t('teamHub.tasks.done.note')}</span>
            <textarea rows={3} maxLength={NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('teamHub.tasks.done.hint')} data-testid="done-note" />
            <small>{t('teamHub.tasks.done.count', { used: note.length, max: NOTE_MAX })}</small>
          </label>
          <div className="tpg-actions">
            <button type="button" className="ck-btn ck-btn--primary" disabled={busy} data-testid="done-send" onClick={() => void run(() => api.done(task.id, note.trim()), () => setPanel(null))}>
              {t('teamHub.tasks.done.send', { name: task.fromName })}
            </button>
            <button type="button" className="ck-btn ck-btn--plain" onClick={() => setPanel(null)}>
              {t('teamHub.tasks.cancel')}
            </button>
          </div>
        </div>
      )}

      {message && (
        <p className="tpg-sub" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="tpg-error" role="alert" data-testid="task-error">
          {error}
        </p>
      )}
      {panel === null && actions.length > 0 && (
        <div className="tpg-actions">
          {actions.includes('accept') && (
            <button type="button" className="ck-btn ck-btn--primary" onClick={() => setPanel('accept')}>
              {t('teamHub.tasks.accept')}
            </button>
          )}
          {actions.includes('start') && (
            <button type="button" className="ck-btn ck-btn--primary" disabled={busy} onClick={start}>
              {t('teamHub.tasks.start')}
            </button>
          )}
          {actions.includes('done') && (
            <button type="button" className="ck-btn ck-btn--secondary" onClick={() => setPanel('done')}>
              {t('teamHub.tasks.done.open', { name: task.fromName })}
            </button>
          )}
          {actions.includes('decline') && (
            <button type="button" className="ck-btn ck-btn--plain" disabled={busy} onClick={() => void run(() => api.decline(task.id))}>
              {t('teamHub.tasks.decline')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function SentCard({ task, api, now, onChanged }: { task: SentTask; api: TeamTasksApi; now: number; onChanged: () => void }) {
  const t = useT();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const repoLine = sentRepoLine(task);
  const closed = task.state === 'done' || task.state === 'declined' || task.state === 'withdrawn';

  const takeBack = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.withdraw(task.id);
      setAsking(false);
      onChanged();
    } catch (e) {
      setError(errorSentence(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`tpg-task${closed ? ' tpg-task--closed' : ''}`} data-testid={`sent-${task.id}`} data-state={task.state}>
      <div className="tpg-task-head">
        <strong className="tpg-name">{t('teamHub.tasks.to', { name: task.toName })}</strong>
        <span className="tpg-chip" data-testid="sent-chip" data-state={task.state}>
          {sentChip(task.state)}
        </span>
        <span className="tpg-sub">{ago(task.updatedMs || task.atMs, now, t)}</span>
      </div>
      <p className="tpg-task-title">{task.title}</p>
      {task.state === 'done' && task.note && (
        <>
          <p className="tpg-sub">{t('teamHub.tasks.theirNote', { name: task.toName })}</p>
          <Quote text={task.note} testId="sent-note" />
        </>
      )}
      {task.repo && (
        <p className="tpg-sub">{t('teamHub.tasks.sentRepo', { name: task.repo.name, branch: task.repo.branch })}</p>
      )}
      {repoLine && (
        <p className="tpg-sub" role="status" data-testid="sent-repo">
          {repoLine}
        </p>
      )}
      {task.repo && task.repoState === 'sent' && task.state !== 'done' && <p className="tpg-sub">{t('teamHub.tasks.repo.noTakeBack')}</p>}
      {error && (
        <p className="tpg-error" role="alert">
          {error}
        </p>
      )}
      {canTakeBack(task) &&
        (asking ? (
          <div className="tpg-actions" data-testid="takeback-confirm">
            <span className="tpg-sub">{t('teamHub.tasks.takeBack.ask', { name: task.toName })}</span>
            <button type="button" className="ck-btn ck-btn--secondary" disabled={busy} data-testid="takeback-yes" onClick={() => void takeBack()}>
              {t('teamHub.tasks.takeBack')}
            </button>
            <button type="button" className="ck-btn ck-btn--plain" onClick={() => setAsking(false)}>
              {t('teamHub.tasks.takeBack.keep')}
            </button>
          </div>
        ) : (
          <div className="tpg-actions">
            <button type="button" className="ck-btn ck-btn--plain" onClick={() => setAsking(true)}>
              {t('teamHub.tasks.takeBack')}
            </button>
          </div>
        ))}
    </div>
  );
}
