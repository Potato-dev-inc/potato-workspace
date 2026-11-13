// Settings > Labs > Assign an issue. Off by default. Shows whether GitHub (gh) is ready, the repositories Puppet
// Master watches, who may start a run, how many run at once, and the recent runs. Every change is one
// `intakeSave` (the backend checks it again) or one `intakeAct`. The copy says what happens and what does not.
import { useCallback, useEffect, useState, type MouseEvent } from 'react';
import { t, useT } from '../../../i18n';
import { tauri } from '../../../lib/tauri';
import {
  intakeAct,
  intakePollNow,
  intakeSave,
  intakeView,
  onIntakeChanged,
  repoLine,
  stateText,
  type GhView,
  type IntakeAction,
  type IntakeConfig,
  type IntakeView,
  type RepoWatch,
  type RunView,
} from '../../../lib/issue-intake';
import { ConfirmSheet, NumberControl } from '../controls';
import { Btn, FieldInput, Note, SettingBlock, SettingRow, SettingToggle } from '../settings-ui';
import { AddRepoSheet, REPOS_CAP } from './AddRepoSheet';

/** Most extra GitHub names on the list (the backend checks it too). */
export const NAMES_CAP = 50;
/** How many recent runs the list shows. */
export const RECENT_CAP = 20;
const NAME_RE = /^[a-z0-9-]{1,39}(\[bot\])?$/;

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** An example name in the empty field: the same in every language. */
const EXAMPLE_NAME = 'someone';

/** One GitHub name, lowercased, with a leading "@" dropped. A bot name is `name[bot]`. */
export function gitHubName(raw: string): { name: string } | { error: string } {
  const name = raw.trim().replace(/^@/, '').toLowerCase();
  if (!NAME_RE.test(name)) return { error: t('intake.nameError') };
  return { name };
}

/** The GitHub line under the switch: signed in as whom, or what to install. */
export function ghLine(gh: GhView): string {
  if (gh.state === 'ready') return gh.login ? t('intake.ghAs', { login: gh.login }) : t('intake.gh');
  return t('intake.ghInstall');
}

/** The number in a pull request link ("/pull/57" -> "57"), only for a github.com link. */
export function prNumber(url: string | null): string | null {
  if (!url || !url.startsWith('https://github.com/')) return null;
  const m = /\/pull\/(\d+)/.exec(url);
  return m ? m[1] : null;
}

function RunRow({ run, busy, onAct }: { run: RunView; busy: boolean; onAct: (action: IntakeAction) => void }) {
  const t = useT();
  const pr = prNumber(run.prUrl);
  const openPr = (e: MouseEvent<HTMLAnchorElement>) => {
    // In the desktop app the system browser opens it; elsewhere the link works as usual.
    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
      e.preventDefault();
      void tauri.openExternalUrl(run.prUrl ?? '');
    }
  };
  return (
    <li className="st-audit-row" aria-label={`#${run.number} ${run.title}`}>
      <span className="st-audit-when">#{run.number}</span>
      <span className="st-audit-what">
        {run.title} · {pr && run.prUrl ? (
          <a className="st-link" href={run.prUrl} target="_blank" rel="noreferrer" onClick={openPr}>
            {t('intake.draftPr', { pr })}
          </a>
        ) : (
          stateText(run)
        )}{' '}
        {run.state === 'declined' && (
          <Btn small disabled={busy} onClick={() => onAct('ask_again')}>
            {t('intake.askAgain')}
          </Btn>
        )}
        {run.state === 'ignored' && (
          <Btn small disabled={busy} onClick={() => onAct('unignore')}>
            {t('intake.stopIgnoring')}
          </Btn>
        )}
      </span>
      <span className="st-audit-who">{run.agentLabel}</span>
    </li>
  );
}

export function AssignIssueSettings({ onSaved, projectPath = null }: { onSaved?: () => void; projectPath?: string | null }) {
  const t = useT();
  const [view, setView] = useState<IntakeView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The repo sheet: `'new'` to add one, a repo to edit it, null when closed. */
  const [sheet, setSheet] = useState<RepoWatch | 'new' | null>(null);
  const [removing, setRemoving] = useState<RepoWatch | null>(null);
  /** The GitHub name being typed; null while the add box is closed. */
  const [naming, setNaming] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setView(await intakeView());
      setError(null);
    } catch (e) {
      // No desktop shell (a browser preview) or the backend is not ready: say so, do not crash.
      setError(t('intake.readFailed', { reason: errText(e) }));
    }
  }, []);

  useEffect(() => {
    let alive = true;
    let stop: (() => void) | undefined;
    void load();
    void onIntakeChanged(() => void load())
      .then((off) => {
        if (alive) stop = off;
        else off();
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      stop?.();
    };
  }, [load]);

  /** Write the whole config. Throws the backend's message; callers decide where it shows. */
  const persist = async (next: IntakeConfig) => {
    setView(await intakeSave(next));
    onSaved?.();
  };

  const change = async (next: IntakeConfig) => {
    setBusy(true);
    setError(null);
    try {
      await persist(next);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const pollNow = async () => {
    setError(null);
    try {
      await intakePollNow();
      await load();
    } catch (e) {
      setError(errText(e));
    }
  };

  const doRun = async (run: RunView, action: IntakeAction) => {
    setBusy(true);
    setError(null);
    try {
      await intakeAct(run.id, action);
      await load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  if (!view) return error ? <Note role="alert">{error}</Note> : <Note role="status">{t('teamPage.loading')}</Note>;

  const { config, gh } = view;
  const names = config.allowed;
  const addName = () => {
    const parsed = gitHubName(naming ?? '');
    if ('error' in parsed) return setNameError(parsed.error);
    if (gh.login && parsed.name === gh.login.toLowerCase()) return setNameError(t('intake.you'));
    if (names.includes(parsed.name)) return setNameError(t('intake.onList'));
    if (names.length >= NAMES_CAP) return setNameError(t('intake.namesCap', { n: NAMES_CAP }));
    setNameError(null);
    setNaming(null);
    void change({ ...config, allowed: [...names, parsed.name] });
  };

  return (
    <>
      {error && <Note role="alert">{error}</Note>}
      <SettingToggle
        label={t('intake.watch')}
        description={t('intake.watchHelp')}
        checked={config.enabled}
        disabled={busy}
        onChange={(on) => void change({ ...config, enabled: on })}
      />
      <SettingRow label="GitHub" /* i18n-ok: product name */ description={ghLine(gh)}>
        <Btn small disabled={busy || gh.state !== 'ready'} onClick={() => void pollNow()}>
          {t('agentPage.checkNow')}
        </Btn>
      </SettingRow>

      <SettingBlock label={t('intake.repos')} description={t('intake.reposHelp')}>
        {view.repos.length === 0 && <Note>{t('intake.noRepos')}</Note>}
        <ul className="st-devices" aria-label={t('intake.watchedRepos')}>
          {view.repos.map((row) => (
            <li key={row.repo.id} className="st-device" aria-label={row.repo.owner_repo}>
              <div className="st-device-head">
                <div className="st-label">
                  <span>{row.repo.owner_repo}</span>
                  <small>{repoLine(row.repo, row.agent_label)}</small>
                </div>
                <div className="st-control">
                  <Btn small disabled={busy} onClick={() => setSheet(row.repo)}>
                    {t('lend.edit')}
                  </Btn>
                  <Btn
                    small
                    disabled={busy}
                    onClick={() =>
                      void change({ ...config, repos: config.repos.map((r) => (r.id === row.repo.id ? { ...r, paused: !r.paused } : r)) })
                    }
                  >
                    {row.repo.paused ? t('intake.resume') : t('intake.pause')}
                  </Btn>
                  <Btn small disabled={busy} onClick={() => setRemoving(row.repo)}>
                    {t('settings.remove')}
                  </Btn>
                </div>
              </div>
              <p className="st-note">{row.status}</p>
            </li>
          ))}
        </ul>
        <Btn disabled={busy || config.repos.length >= REPOS_CAP} onClick={() => setSheet('new')}>
          {t('intake.addRepo')}
        </Btn>
        {config.repos.length >= REPOS_CAP && <Note>{t('intake.reposCap', { n: REPOS_CAP })}</Note>}
      </SettingBlock>

      <SettingBlock
        label={t('intake.who')}
        description={t('intake.whoHelp')}
      >
        <ul className="st-abilities" aria-label={t('intake.who')}>
          <li className="st-ability">
            <div className="st-label">
              <span>{t('security.who.desktop')}</span>
              <small>{gh.login ? `@${gh.login}` : t('intake.yourGh')}</small>
            </div>
          </li>
          {names.map((name) => (
            <li key={name} className="st-ability">
              <div className="st-label">
                <span>@{name}</span>
              </div>
              <Btn small disabled={busy} onClick={() => void change({ ...config, allowed: names.filter((n) => n !== name) })}>
                {t('settings.remove')}
              </Btn>
            </li>
          ))}
        </ul>
        {naming === null ? (
          <Btn
            disabled={busy || names.length >= NAMES_CAP}
            onClick={() => {
              setNaming('');
              setNameError(null);
            }}
          >
            {t('intake.addName')}
          </Btn>
        ) : (
          <div className="st-path">
            <FieldInput
              aria-label={t('intake.nameAria')}
              className="font-mono"
              value={naming}
              placeholder={EXAMPLE_NAME}
              onChange={(e) => setNaming(e.target.value)}
            />
            <Btn primary disabled={busy} onClick={addName}>
              {t('keepGoing.add')}
            </Btn>
            <Btn
              onClick={() => {
                setNaming(null);
                setNameError(null);
              }}
            >
              {t('lend.cancel')}
            </Btn>
          </div>
        )}
        {names.length >= NAMES_CAP && <Note>{t('intake.namesCap', { n: NAMES_CAP })}</Note>}
        {nameError && <Note role="alert">{nameError}</Note>}
        <SettingToggle
          label={t('intake.write')}
          description={t('intake.writeHelp')}
          checked={config.write_access_counts}
          disabled={busy}
          onChange={(on) => void change({ ...config, write_access_counts: on })}
        />
      </SettingBlock>

      <SettingRow label={t('intake.parallel')} description={t('intake.parallelHelp')}>
        <NumberControl
          aria-label={t('intake.parallel')}
          min={1}
          max={3}
          value={config.parallel}
          disabled={busy}
          onCommit={(next) => change({ ...config, parallel: next })}
        />
      </SettingRow>

      <SettingBlock label={t('intake.recent')} description={t('intake.recentHelp', { n: RECENT_CAP })}>
        {view.runs.length === 0 ? (
          <Note>{t('intake.noRuns')}</Note>
        ) : (
          <ul className="st-audit" aria-label={t('intake.recentRuns')}>
            {view.runs.slice(0, RECENT_CAP).map((run) => (
              <RunRow key={run.id} run={run} busy={busy} onAct={(action) => void doRun(run, action)} />
            ))}
          </ul>
        )}
      </SettingBlock>

      <Note>{t('intake.footer')}</Note>

      {sheet !== null && (
        <AddRepoSheet
          editing={sheet === 'new' ? null : sheet}
          repos={config.repos}
          projectPath={projectPath}
          onCancel={() => setSheet(null)}
          onSave={async (repo) => {
            const next = sheet === 'new' ? [...config.repos, repo] : config.repos.map((r) => (r.id === repo.id ? repo : r));
            await persist({ ...config, repos: next });
            setSheet(null);
          }}
        />
      )}
      {removing && (
        <ConfirmSheet
          title={t('intake.stopTitle', { repo: removing.owner_repo })}
          body={t('intake.stopBody')}
          confirmLabel={t('ci.stopWatching')}
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            const gone = removing;
            setRemoving(null);
            void change({ ...config, repos: config.repos.filter((r) => r.id !== gone.id) });
          }}
        />
      )}
    </>
  );
}
