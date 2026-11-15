// "Pass a task": who, what, what goes along, whose usage. One sheet, four short parts, one button.
// Nothing leaves this PC until "Pass to {name}" is pressed. A repo copy needs the own-risk tick as well.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../../i18n';
import { durationWords, type LendState } from '../../lib/lend';
import { errorSentence } from '../../lib/sayError';
import type { RepoCheck, RepoHistory, TasksView, TeamTasksApi } from '../../lib/team-tasks';
import '../../styles/cockpit-team-page.css';
import { initials, personHue } from './person-color';
import { pickFolder as defaultPick, type FolderPicker } from './pickFolder';
import { presenceWords, type Person } from './team-page-model';
import {
  byteLength,
  lendableProfiles,
  lendChoices,
  lendWords,
  passProblem,
  repoDisabledReason,
  sizeWords,
  SUMMARY_MAX_BYTES,
  TEXT_MAX_BYTES,
  TITLE_MAX,
  type RepoChoice,
} from './tasks-model';

const folderName = (path: string): string => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;

/** The big plain box for sending a copy of code. The tick must be set before the send button works. */
export function RepoRiskBox({ head, lines, tick, checked, onChange }: { head: string; lines: string[]; tick: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="tpg-risk" role="group" aria-label={head} data-testid="repo-risk">
      <strong>{head}</strong>
      {lines.map((l) => (
        <p key={l}>{l}</p>
      ))}
      <label className="tpg-tick">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} data-testid="repo-risk-tick" />
        <span>{tick}</span>
      </label>
    </div>
  );
}

export function PassTaskSheet({
  people,
  initialMember = null,
  repoPath = null,
  summary = '',
  tasks,
  lend,
  api,
  onClose,
  onSent,
  pick = defaultPick,
}: {
  /** Everyone on the team. Me is left out. */
  people: Person[];
  /** Who is chosen when the sheet opens (the person card it was opened from). */
  initialMember?: string | null;
  /** The folder of the chat it was opened from: the repo that may go along. */
  repoPath?: string | null;
  /** The short summary of that chat, when there is one. */
  summary?: string;
  tasks: Pick<TasksView, 'handoverOn' | 'lendOn' | 'repoCapBytes'>;
  lend: LendState | null;
  api: Pick<TeamTasksApi, 'pass' | 'repoCheck'>;
  onClose: () => void;
  onSent: () => void;
  pick?: FolderPicker;
}) {
  const t = useT();
  const others = people.filter((p) => !p.member.me);
  const [toMember, setTo] = useState<string | null>(initialMember && others.some((p) => p.member.id === initialMember) ? initialMember : null);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [summaryOn, setSummaryOn] = useState(false);
  const [summaryText, setSummaryText] = useState(summary);
  const [choice, setChoice] = useState<RepoChoice>('words');
  const [history, setHistory] = useState<RepoHistory>('latest');
  const [understood, setUnderstood] = useState(false);
  const [folder, setFolder] = useState<string | null>(repoPath);
  const [check, setCheck] = useState<RepoCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [usage, setUsage] = useState<'theirs' | 'mine'>('theirs');
  const [profileId, setProfileId] = useState<string>('');
  const [secs, setSecs] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Look at the folder as soon as there is one, so the choice can say plainly why it is off.
  const seq = useRef(0);
  useEffect(() => {
    if (!folder) {
      setCheck(null);
      return;
    }
    const mine = ++seq.current;
    setChecking(true);
    api
      .repoCheck(folder)
      .then((c) => mine === seq.current && setCheck(c))
      .catch((e) => mine === seq.current && setCheck({ ok: false, name: '', branch: '', reason: errorSentence(e) }))
      .finally(() => mine === seq.current && setChecking(false));
  }, [folder, api]);

  const profiles = useMemo(() => lendableProfiles(lend, toMember), [lend, toMember]);
  const profile = profiles.find((p) => p.id === profileId) ?? profiles[0] ?? null;
  const choices = profile ? lendChoices(profile) : [];
  const lendIsOffered = tasks.lendOn && profile !== null && choices.length > 0;
  const chosenSecs = choices.includes(secs) ? secs : (choices.find((s) => s >= (profile?.default_secs ?? 0)) ?? choices[choices.length - 1] ?? 0);

  const repoReason = repoDisabledReason({ handoverOn: tasks.handoverOn, folder, check, checking });
  const effectiveChoice: RepoChoice = repoReason ? 'words' : choice;
  const person = others.find((p) => p.member.id === toMember) ?? null;

  const problem = passProblem({ toMember, title, text, summaryOn, summary: summaryText, choice: effectiveChoice, history, understood });
  const textBytes = byteLength(text);
  const summaryBytes = byteLength(summaryText);

  const send = async () => {
    if (problem || !toMember || sending) return;
    setSending(true);
    setError(null);
    try {
      await api.pass({
        toMember,
        title: title.trim(),
        text,
        summary: summaryOn ? summaryText : '',
        ...(effectiveChoice === 'repo' && folder ? { repo: { path: folder, history, understood } } : {}),
        ...(usage === 'mine' && lendIsOffered && profile ? { lend: { profileId: profile.id, secs: chosenSecs } } : {}),
      });
      onSent();
      onClose();
    } catch (e) {
      setError(errorSentence(e));
    } finally {
      setSending(false);
    }
  };

  const reviewParts: string[] = [effectiveChoice === 'repo' && check ? t('teamHub.pass.review.repo', { name: check.name || folderName(folder ?? '') }) : t('teamHub.pass.review.words')];
  reviewParts.push(usage === 'mine' && lendIsOffered && profile ? t('teamHub.pass.review.mine', { profile: profile.name }) : t('teamHub.pass.review.theirs'));

  return (
    <div className="tpg-modal" data-testid="pass-sheet-backdrop">
      <div className="tpg-sheet tpg-sheet--pass" role="dialog" aria-modal="true" aria-label={t('teamHub.pass.title')} data-testid="pass-sheet">
        <h3 className="tpg-sheet-title">{t('teamHub.pass.title')}</h3>

        <fieldset className="tpg-radios tpg-step">
          <legend className="tpg-step-h">{t('teamHub.pass.who')}</legend>
          {others.length === 0 && <p className="tpg-sub">{t('teamHub.pass.nobody')}</p>}
          {others.map((p) => (
            <label key={p.member.id} className="tpg-radio tpg-who" data-testid={`pass-who-${p.member.id}`}>
              <input type="radio" name="pass-who" checked={toMember === p.member.id} onChange={() => setTo(p.member.id)} />
              <span className="tpg-avatar tpg-avatar--small" data-hue={personHue(p.member.id)} aria-hidden="true">
                {initials(p.member.name)}
              </span>
              <span>
                <strong className="tpg-name">{p.member.name}</strong>
                <small className="tpg-presence" data-kind={p.kind}>
                  <span className="tpg-dot" aria-hidden="true" />
                  {presenceWords(p.presence, Date.now())}
                </small>
                {p.kind === 'gone' && <small>{t('teamHub.pass.notHere')}</small>}
              </span>
            </label>
          ))}
        </fieldset>

        <div className="tpg-step">
          <h4 className="tpg-step-h">{t('teamHub.pass.what')}</h4>
          <label className="tpg-field">
            <span>{t('teamHub.pass.titleLabel')}</span>
            <input className="tpg-input" value={title} maxLength={TITLE_MAX} onChange={(e) => setTitle(e.target.value)} data-testid="pass-title" placeholder={t('teamHub.pass.titleHint')} />
          </label>
          <label className="tpg-field">
            <span>{t('teamHub.pass.taskLabel')}</span>
            <textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder={t('teamHub.pass.taskHint')} data-testid="pass-text" aria-invalid={textBytes > TEXT_MAX_BYTES} />
            <small data-over={textBytes > TEXT_MAX_BYTES} data-testid="pass-text-count">
              {t('teamHub.pass.bytesOf', { used: textBytes.toLocaleString('en-US'), max: TEXT_MAX_BYTES.toLocaleString('en-US') })}
            </small>
          </label>
          {summary !== '' && (
            <>
              <label className="tpg-tick">
                <input type="checkbox" checked={summaryOn} onChange={(e) => setSummaryOn(e.target.checked)} data-testid="pass-summary-on" />
                <span>{t('teamHub.pass.summaryOn')}</span>
              </label>
              {summaryOn && (
                <label className="tpg-field">
                  <span>{t('teamHub.pass.summaryLabel')}</span>
                  <textarea rows={3} value={summaryText} onChange={(e) => setSummaryText(e.target.value)} data-testid="pass-summary" />
                  <small data-over={summaryBytes > SUMMARY_MAX_BYTES}>
                    {t('teamHub.pass.bytesOf', { used: summaryBytes.toLocaleString('en-US'), max: SUMMARY_MAX_BYTES.toLocaleString('en-US') })}
                  </small>
                </label>
              )}
            </>
          )}
        </div>

        <fieldset className="tpg-radios tpg-step">
          <legend className="tpg-step-h">{t('teamHub.pass.along')}</legend>
          <label className="tpg-radio">
            <input type="radio" name="pass-along" checked={effectiveChoice === 'words'} onChange={() => setChoice('words')} data-testid="pass-words" />
            <span>
              {t('teamHub.pass.words')}
              <small>{t('teamHub.pass.words.note')}</small>
            </span>
          </label>
          <label className="tpg-radio">
            <input type="radio" name="pass-along" checked={effectiveChoice === 'repo'} disabled={repoReason !== null} onChange={() => setChoice('repo')} data-testid="pass-repo" />
            <span>
              {t('teamHub.pass.repo')}
              <small>{t('teamHub.pass.repo.note', { max: sizeWords(tasks.repoCapBytes) })}</small>
              {repoReason && (
                <small className="tpg-why" data-testid="pass-repo-why">
                  {repoReason}
                </small>
              )}
            </span>
          </label>
          <div className="tpg-folder">
            {folder && <small className="tpg-sub tpg-path" data-testid="pass-folder">{folder}</small>}
            <button type="button" className="ck-btn ck-btn--plain" data-testid="pass-pick" onClick={() => void pick(folder).then((p) => p && setFolder(p))}>
              {t('teamHub.pass.pick')}
            </button>
          </div>
          {effectiveChoice === 'repo' && (
            <>
              <label className="tpg-radio">
                <input type="radio" name="pass-history" checked={history === 'latest'} onChange={() => setHistory('latest')} />
                <span>
                  {t('teamHub.pass.history.latest')}
                  <small>{t('teamHub.pass.history.latestNote')}</small>
                </span>
              </label>
              <label className="tpg-radio">
                <input type="radio" name="pass-history" checked={history === 'full'} onChange={() => setHistory('full')} />
                <span>{t('teamHub.pass.history.full')}</span>
              </label>
              <RepoRiskBox head={t('teamHub.pass.risk.head')} lines={[t('teamHub.pass.risk.line1'), t('teamHub.pass.risk.line2')]} tick={t('teamHub.pass.risk.tick')} checked={understood} onChange={setUnderstood} />
            </>
          )}
        </fieldset>

        {tasks.lendOn && (
          <fieldset className="tpg-radios tpg-step">
            <legend className="tpg-step-h">{t('teamHub.pass.usage')}</legend>
            <label className="tpg-radio">
              <input type="radio" name="pass-usage" checked={usage === 'theirs' || !lendIsOffered} onChange={() => setUsage('theirs')} data-testid="pass-usage-theirs" />
              <span>
                {t('teamHub.pass.usage.theirs')}
                <small>{t('teamHub.pass.usage.theirsNote')}</small>
              </span>
            </label>
            <label className="tpg-radio">
              <input type="radio" name="pass-usage" checked={usage === 'mine' && lendIsOffered} disabled={!lendIsOffered} onChange={() => setUsage('mine')} data-testid="pass-usage-mine" />
              <span>
                {t('teamHub.pass.usage.mine')}
                {!lendIsOffered && <small className="tpg-why">{t('teamHub.pass.usage.none')}</small>}
                {lendIsOffered && profile && usage === 'mine' && (
                  <span className="tpg-lendpick">
                    <select value={profile.id} onChange={(e) => setProfileId(e.target.value)} aria-label={t('teamHub.pass.usage.profile')} data-testid="pass-profile">
                      {profiles.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                    <select value={chosenSecs} onChange={(e) => setSecs(Number(e.target.value))} aria-label={t('teamHub.pass.usage.duration')} data-testid="pass-secs">
                      {choices.map((s) => (
                        <option key={s} value={s}>
                          {durationWords(s)}
                        </option>
                      ))}
                    </select>
                    <small>{lendWords(profile.name, chosenSecs)}</small>
                  </span>
                )}
              </span>
            </label>
          </fieldset>
        )}

        <p className="tpg-sub tpg-review" data-testid="pass-review">
          {reviewParts.join(' · ')}
        </p>
        {error && (
          <p className="tpg-error" role="alert" data-testid="pass-error">
            {error}
          </p>
        )}
        <div className="tpg-actions">
          <button type="button" className="ck-btn ck-btn--plain" onClick={onClose}>
            {t('teamHub.pass.cancel')}
          </button>
          <button type="button" className="ck-btn ck-btn--primary" disabled={problem !== null || sending} title={problem ?? undefined} data-testid="pass-send" onClick={() => void send()}>
            {t('teamHub.pass.send', { name: person?.member.name ?? t('teamHub.pass.sendFallback') })}
          </button>
        </div>
      </div>
    </div>
  );
}
