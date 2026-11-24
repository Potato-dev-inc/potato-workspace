// "Set up agents": which of my AI agents work, and how do I fix the ones that do not?
// Monochrome list; the glyph reuses DotSpinner's static patterns:
//   idle = installed or missing but not tested, exited (check) = ready,
//   waiting_input (plus) = needs you to sign in, error (cross) = problem.
import { errorSentence } from '../../lib/sayError';
import { t, useT } from '../../i18n';
import { backendText } from '../../lib/backendWords';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useHost } from '../../lib/host/context';
import { agentHealthApiFor, type AgentHealth, type AgentHealthApi } from '../../lib/agent-health';
import { agentReadiness, type AgentReadiness, type ReadinessState } from '../../lib/agentReadiness';
import { rememberTest } from '../../lib/setup-checks/test-memory';
import { useTestMemory } from '../../lib/useAgentReadiness';
import { ownLoginApiFor, type OwnLogin } from '../settings/agents/ownSignIn';
import { agentInstallApi, type AgentInstallApi, type InstallPlan } from '../../lib/agent-install';
import { CodeText } from '../common/CodeText';
import { DotSpinner, type DotSpinnerProps } from './DotSpinner';
import { InstallSheet } from './InstallSheet';
import '../../styles/agent-doctor.css';

export function glyphFor(state: ReadinessState): DotSpinnerProps['status'] {
  switch (state) {
    case 'ready':
    case 'signed_in':
      return 'exited';
    case 'needs_sign_in':
      return 'waiting_input';
    case 'broken':
      return 'error';
    default:
      return 'idle';
  }
}

type Action = 'install' | 'signin' | 'test' | 'copy';

const actionLabel = (a: Action): string => t(({ install: 'r21.doc.install', signin: 'r21.doc.signin', test: 'r21.doc.test', copy: 'r21.doc.copyInstall' } as const)[a]);
const actionTitle = (a: Action): string => t(({ install: 'r21.doc.tInstall', signin: 'r21.doc.tSignin', test: 'r21.doc.tTest', copy: 'r21.doc.tCopy' } as const)[a]);

/** The one thing a row asks you to do next; the rest goes under More. `null`: nothing to do. */
export function primaryAction(r: AgentHealth, standing: AgentReadiness): Action | null {
  if (standing.state === 'not_installed') return 'install';
  if (standing.state === 'needs_sign_in') return 'signin';
  if ((standing.state === 'not_checked' || standing.state === 'broken' || standing.state === 'signed_in') && r.installed && r.can_test) return 'test';
  return null;
}

/** Everything else this row can do. */
export function moreActions(r: AgentHealth, primary: Action | null): Action[] {
  const out: Action[] = [];
  if (r.state === 'not_installed' && r.install_hint) out.push('copy');
  if (r.installed && primary !== 'signin') out.push('signin');
  if (r.installed && r.can_test && primary !== 'test') out.push('test');
  return out;
}

const GROUPS = [
  { id: 'needs', title: 'r21.doc.needsYou' },
  { id: 'ready', title: 'r21.doc.ready' },
  { id: 'missing', title: 'r21.doc.notInstalled' },
] as const;

function groupOf(state: ReadinessState): 'needs' | 'ready' | 'missing' {
  return state === 'ready' || state === 'signed_in' ? 'ready' : state === 'not_installed' ? 'missing' : 'needs';
}

/** The row's sentence. A raw exit code never shows; it stays in the tooltip. */
function plainReason(r: AgentHealth): string {
  if (r.state === 'error' && /exit code|did not start/i.test(r.reason)) {
    return t('r21.doc.didNotStart', { label: r.label });
  }
  return backendText(r.reason);
}

/** The sign-in note sits behind a "?" so the row stays short. Closed by default. */
function SignInHelp({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const panel = `${id}-signin-help`;
  return (
    <div className="ck-doctor-signin">
      <button
        type="button"
        className="ck-btn ck-btn--plain ck-btn--sm"
        aria-label={t('r21.doc.aboutSignin')}
        aria-expanded={open}
        aria-controls={open ? panel : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        ?
      </button>
      {open && (
        <p id={panel} className="ck-doctor-hint">
          {t('r21.doc.signinHelp')}
        </p>
      )}
    </div>
  );
}

export interface AgentDoctorProps {
  /** Starts the agent in a visible pane so the user can sign in. */
  onOpenAgent: (agentId: string) => void;
  onNotify?: (text: string) => void;
  onClose?: () => void;
  api?: AgentHealthApi;
  installApi?: AgentInstallApi;
  /** Brings the install window (a visible pane) to the front. */
  onShowPane?: (paneId: string) => void;
  /** Inside another screen (the first-run welcome): no page title or Close, only "Check again". */
  embedded?: boolean;
  /** Called with the list whenever it loads or a test changes a row. */
  onRows?: (rows: AgentHealth[]) => void;
  /** Opens the Agent Store. The "Browse more agents" link shows only when this is given. */
  onOpenStore?: () => void;
}

/** Where one row's install is. Absent = nothing going on. */
type Install =
  | { phase: 'loading' }
  | { phase: 'running'; paneId: string; label: string; tool: string | null }
  | { phase: 'finishing' }
  | { phase: 'result'; tone: 'ok' | 'problem'; text: string; again?: boolean; restart?: boolean };

const POLL_MS = 1500;

/** Installs outlive this screen: Show window leaves it, and the install goes on in its window. */
let keptInstalls: Record<string, Install> = {};
export function resetKeptInstalls(): void {
  keptInstalls = {};
}

export function AgentDoctor({
  onOpenAgent,
  onNotify,
  onClose,
  api: givenApi,
  installApi = agentInstallApi,
  onShowPane,
  embedded = false,
  onRows,
  onOpenStore,
}: AgentDoctorProps) {
  useT();
  const host = useHost();
  const api = useMemo(() => givenApi ?? agentHealthApiFor(host), [givenApi, host]);
  const [rows, setRows] = useState<AgentHealth[] | null>(null);
  const [installs, setInstalls] = useState<Record<string, Install>>(() => keptInstalls);
  const [sheet, setSheet] = useState<{ agentId: string; plan: InstallPlan; busy: boolean; error: string | null } | null>(
    null,
  );
  const installsRef = useRef(installs);
  installsRef.current = installs;
  keptInstalls = installs;
  const [loadError, setLoadError] = useState<string | null>(null);
  const [testing, setTesting] = useState<Set<string>>(new Set());
  // How each agent stands is `agentReadiness`, the same words as the Overview and the Agents cards: from the check, the login read and the kept Tests.
  const tests = useTestMemory();
  const [logins, setLogins] = useState<OwnLogin[] | null>(null);
  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(() => ownLoginApiFor(host).states())
      .then((l) => live && setLogins(l), () => undefined);
    return () => {
      live = false;
    };
  }, [host, rows]);
  const standingOf = (r: AgentHealth): AgentReadiness => agentReadiness(r.id, { health: rows ?? [], logins, tests });

  const load = useCallback(() => {
    setLoadError(null);
    api
      .check()
      .then(setRows)
      .catch((e) => setLoadError(errorSentence(e)));
  }, [api]);

  useEffect(load, [load]);
  const onRowsRef = useRef(onRows);
  onRowsRef.current = onRows;
  useEffect(() => {
    if (rows) onRowsRef.current?.(rows);
  }, [rows]);

  const test = (id: string) => {
    setTesting((s) => new Set(s).add(id));
    api
      .test(id)
      .then((result) => {
        rememberTest(result); // the Overview and the Agents cards read the same memory
        setRows((cur) => (cur ?? []).map((r) => (r.id === id ? result : r)));
      })
      .catch((e) =>
        setRows((cur) =>
          (cur ?? []).map((r) =>
            r.id === id
              ? { ...r, state: 'error', reason: t('r21.doc.testFailed', { why: errorSentence(e) }) }
              : r,
          ),
        ),
      )
      .finally(() =>
        setTesting((s) => {
          const next = new Set(s);
          next.delete(id);
          return next;
        }),
      );
  };

  const setInstall = (id: string, next: Install | null) =>
    setInstalls((cur) => {
      const copy = { ...cur };
      if (next) copy[id] = next;
      else delete copy[id];
      return copy;
    });

  const errText = (e: unknown) => (errorSentence(e)).replace(/^[A-Z_]+: /, '');

  /** Install: fetch the exact commands and show them. Nothing runs yet. */
  const openInstall = (id: string) => {
    setInstall(id, { phase: 'loading' });
    installApi
      .plan(id)
      .then((plan) => {
        setInstall(id, null);
        setSheet({ agentId: id, plan, busy: false, error: null });
      })
      .catch((e) => setInstall(id, { phase: 'result', tone: 'problem', text: errText(e) }));
  };

  /** Run: the confirmed step goes to a visible window. */
  const runInstall = (acknowledgedRisk: boolean) => {
    if (!sheet) return;
    const { agentId, plan } = sheet;
    const step = plan.steps[0];
    setSheet({ ...sheet, busy: true, error: null });
    installApi
      .run(agentId, step.index, step.command, acknowledgedRisk)
      .then((started) => {
        setSheet(null);
        setInstall(agentId, { phase: 'running', paneId: started.pane_id, label: step.label, tool: step.tool });
      })
      .catch((e) => setSheet((cur) => (cur ? { ...cur, busy: false, error: errText(e) } : cur)));
  };

  /** The window's command ended: refresh PATH, check the agent again, say what happened. */
  const finishInstall = (id: string, tool: string | null, exitCode: number | null, message: string | null) => {
    setInstall(id, { phase: 'finishing' });
    installApi
      .finish(id)
      .then((res) => {
        setRows((cur) => (cur ?? []).map((r) => (r.id === id ? res.health : r)));
        if (res.health.installed) {
          setInstall(id, { phase: 'result', tone: 'ok', text: t('r21.doc.installedNext') });
        } else if (tool && exitCode === 0) {
          // A prerequisite is in place: ask about the next step (a fresh plan, so it is accurate).
          openInstall(id);
        } else if (exitCode === 0) {
          setInstall(id, {
            phase: 'result',
            tone: 'problem',
            text: t('r21.doc.cannotFind'),
            again: true,
          });
        } else {
          setInstall(id, {
            phase: 'result',
            tone: 'problem',
            text: t('r21.doc.pcFine', { message: message ?? t('r21.doc.installUnfinished') }),
          });
        }
      })
      .catch((e) => setInstall(id, { phase: 'result', tone: 'problem', text: errText(e) }));
  };

  /** Check again after "cannot find it yet": the same check the install window's end runs, for this agent only. */
  const recheck = (id: string) => {
    setInstall(id, { phase: 'finishing' });
    installApi
      .finish(id)
      .then((res) => {
        setRows((cur) => (cur ?? []).map((r) => (r.id === id ? res.health : r)));
        if (res.health.installed) {
          setInstall(id, { phase: 'result', tone: 'ok', text: t('r21.doc.installedNext') });
        } else {
          setInstall(id, {
            phase: 'result',
            tone: 'problem',
            text: t('r21.doc.cannotFind'),
            again: true,
            restart: true,
          });
        }
      })
      .catch(() => setInstall(id, { phase: 'result', tone: 'problem', text: t('r21.doc.couldNotCheck'), again: true }));
  };

  // While an install window is open, ask whether its command has finished.
  const runningKey = Object.entries(installs)
    .filter(([, v]) => v.phase === 'running')
    .map(([k]) => k)
    .join(',');
  useEffect(() => {
    if (!runningKey) return;
    const timer = window.setInterval(() => {
      for (const id of runningKey.split(',')) {
        const cur = installsRef.current[id];
        if (!cur || cur.phase !== 'running') continue;
        installApi
          .status(cur.paneId)
          .then((st) => {
            const now = installsRef.current[id];
            if (!now || now.phase !== 'running' || now.paneId !== cur.paneId) return;
            if (st.done) finishInstall(id, cur.tool, st.exit_code, st.message);
          })
          .catch(() => {});
      }
    }, POLL_MS);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningKey, installApi]);

  const copy = (text: string) => {
    const done = () => onNotify?.(t('r21.doc.copied'));
    const failed = () => onNotify?.(t('r21.doc.copyFailed'));
    if (!navigator.clipboard) return failed();
    navigator.clipboard.writeText(text).then(done).catch(failed);
  };

  const readyCount = rows?.filter((r) => standingOf(r).state === 'ready').length ?? 0;

  return (
    <div className={embedded ? 'ck-doctor ck-doctor--embedded' : 'ck-doctor'}>
      <header className="ck-doctor-head">
        {!embedded && (
          <>
            <h1 className="ck-title">{t('r21.doc.title')}</h1>
            <p className="ck-sub">
              {t('r21.doc.intro')}
              {readyCount > 0 ? ` ${t('r21.doc.readyCount', { n: readyCount })}` : ''}
            </p>
          </>
        )}
        <div className="ck-doctor-bar">
          <button type="button" className="ck-btn ck-btn--plain ck-btn--sm" onClick={load}>
            {t('r21.doc.checkAgain')}
          </button>
          {onClose && !embedded && (
            <button type="button" className="ck-btn ck-btn--plain ck-btn--sm" onClick={onClose}>
              {t('r21.doc.close')}
            </button>
          )}
        </div>
      </header>

      {loadError && (
        <div className="ck-doctor-error">
          <p className="ck-sub">{t('r21.doc.couldNotCheckAgents')}</p>
          <button type="button" className="ck-btn ck-btn--secondary ck-btn--sm" onClick={load}>
            {t('r21.doc.checkAgain')}
          </button>
        </div>
      )}
      {!rows && !loadError && <p className="ck-sub">{t('r21.doc.looking')}</p>}

      {rows && (
        <div className="ck-doctor-groups">
          {GROUPS.map((group) => {
            const inGroup = rows.filter((r) => groupOf(standingOf(r).state) === group.id);
            if (inGroup.length === 0) return null;
            return (
              <section key={group.id} aria-label={t(group.title)}>
                <h2 className="ck-doctor-cap">{t(group.title)}</h2>
                <ul className="ck-list ck-doctor-list" aria-label={t(group.title)}>
                  {inGroup.map((r) => {
                    const busy = testing.has(r.id);
                    const inst = installs[r.id];
                    const working = inst?.phase === 'loading' || inst?.phase === 'running' || inst?.phase === 'finishing';
                    const installedNow = r.installed && inst?.phase === 'result' && inst.tone === 'ok';
                    const standing = standingOf(r);
                    const primary = primaryAction(r, standing);
                    const more = moreActions(r, primary);
                    const run = (action: Action) => {
                      if (action === 'install') openInstall(r.id);
                      else if (action === 'signin') onOpenAgent(r.id);
                      else if (action === 'test') test(r.id);
                      else if (r.install_hint) copy(r.install_hint);
                    };
                    return (
                      <li key={r.id} className="ck-doctor-row" data-state={standing.state}>
                        <span className="ck-row-glyph">
                          <DotSpinner status={busy || working ? 'running' : glyphFor(standing.state)} />
                        </span>
                        <div className="ck-doctor-main">
                          <div className="ck-doctor-line">
                            <span className="ck-row-title">{r.label}</span>
                            <span className="ck-doctor-state">
                              {busy ? t('r21.doc.testing') : working ? (inst?.phase === 'finishing' ? t('r21.doc.checking') : t('r21.doc.installing')) : standing.label}
                            </span>
                            {r.version && <span className="ck-doctor-version">{r.version}</span>}
                          </div>
                          {!installedNow && (
                            <p className="ck-doctor-reason" title={r.state === 'error' ? r.reason : undefined}>
                              {busy
                                ? t('r21.doc.asking')
                                : inst?.phase === 'running'
                                  ? t('r21.doc.installingIn', { label: inst.label })
                                  : inst?.phase === 'finishing'
                                    ? t('r21.doc.checkingWorks')
                                    : standing.state === 'ready' || standing.state === 'signed_in' ? standing.detail : standing.detail && standing.state === 'needs_sign_in' ? standing.detail : plainReason(r)}
                            </p>
                          )}
                          {inst?.phase === 'result' && (
                            <>
                              <p className="ck-doctor-hint ck-doctor-result" data-tone={inst.tone} role="status">
                                {inst.text}
                              </p>
                              {inst.restart && <p className="ck-doctor-hint">{t('r21.doc.restart')}</p>}
                              {inst.again && (
                                <button type="button" className="ck-btn ck-btn--secondary ck-btn--sm" onClick={() => recheck(r.id)}>
                                  {t('r21.doc.checkAgain')}
                                </button>
                              )}
                            </>
                          )}
                          {r.installed && r.hooks && r.hooks.state !== 'not_supported' && r.hooks.state !== 'off' && (
                            <>
                              <p className="ck-doctor-live" data-live={r.hooks.state}>
                                {t('r21.doc.live', { sentence: backendText(r.hooks.sentence) })}
                              </p>
                              {r.hooks.how_to && <p className="ck-doctor-hint">{backendText(r.hooks.how_to)}</p>}
                            </>
                          )}
                          {(standing.state === 'needs_sign_in' || installedNow) && <SignInHelp id={r.id} />}
                          {!working && (r.install_hint || r.install_fallback || r.login_hint) && (
                            <details className="ck-doctor-details">
                              <summary>{t('r21.doc.details')}</summary>
                              {r.state === 'not_installed' && r.install_hint && (
                                <>
                                  <p className="ck-doctor-hint">{t('r21.doc.installYourself')}</p>
                                  <code className="ck-doctor-cmd">{r.install_hint}</code>
                                </>
                              )}
                              {r.state === 'not_installed' && r.install_fallback && (
                                <p className="ck-doctor-hint">
                                  <span className="ck-sub">{t('r21.doc.orNpm')}</span>
                                  <code className="ck-doctor-cmd">{r.install_fallback}</code>
                                </p>
                              )}
                              {r.state !== 'not_installed' && r.login_hint && (
                                <p className="ck-doctor-hint">
                                  <CodeText text={r.login_hint} />
                                </p>
                              )}
                            </details>
                          )}
                        </div>
                        <div className="ck-doctor-actions">
                          {inst?.phase === 'running' && onShowPane && (
                            <button type="button" className="ck-btn ck-btn--secondary ck-btn--sm" onClick={() => onShowPane(inst.paneId)}>
                              {t('r21.doc.showWindow')}
                            </button>
                          )}
                          {primary && !working && (
                            <button
                              type="button"
                              className="ck-btn ck-btn--primary ck-btn--sm"
                              disabled={busy && primary === 'test'}
                              onClick={() => run(primary)}
                              title={actionTitle(primary)}
                            >
                              {actionLabel(primary)}
                            </button>
                          )}
                          {more.length > 0 && !working && (
                            <details className="ck-doctor-more">
                              <summary aria-label={t('r21.doc.moreFor', { label: r.label })}>{t('r21.doc.more')}</summary>
                              <div className="ck-doctor-more-list">
                                {more.map((action) => (
                                  <button
                                    key={action}
                                    type="button"
                                    className="ck-btn ck-btn--plain ck-btn--sm"
                                    disabled={busy && action === 'test'}
                                    onClick={() => run(action)}
                                    title={actionTitle(action)}
                                  >
                                    {actionLabel(action)}
                                  </button>
                                ))}
                              </div>
                            </details>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
          {rows.length === 0 && <p className="ck-sub ck-pad">{t('r21.doc.none')}</p>}
        </div>
      )}
      {onOpenStore && (
        <p className="ck-pad">
          <button type="button" className="ck-link" onClick={onOpenStore}>
            {t('r21.doc.browse')}
          </button>
        </p>
      )}
      {sheet && (
        <InstallSheet
          plan={sheet.plan}
          busy={sheet.busy}
          error={sheet.error}
          onRun={runInstall}
          onCancel={() => setSheet(null)}
          onCopy={copy}
        />
      )}
    </div>
  );
}
