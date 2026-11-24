// "Install <agent> on <PC>?" (P6.2 + P6.3). The person is NOT a developer: the app runs the install on the far PC itself (each step in a
// visible far terminal window, three tries per step). Only when that fails does it hand over: a shell on the far PC, the command and the
// vendor page with Copy, and Done. Done asks the far PC again; if the agent is still missing it says so and offers "Ask my agent"
// (the error and the goal as text for an agent on THIS PC; the far side's words are marked as data, never as instructions).
import { useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n';
import { errorSentence } from '../../lib/sayError';
import type { AgentInstallApi, InstallPlan } from '../../lib/agent-install';
import { tauri } from '../../lib/tauri';
import { checkOnFar, farInstallApi, runFarInstall, type StepProgress } from '../../lib/host/farInstall';
import type { EnsureResult, InstallRequest } from '../../lib/host/ensureInstalled';
import { Sheet } from '../cockpit/Sheet';
import { FarTerminal } from './FarTerminal';

type Phase = 'loading' | 'ask' | 'running' | 'hand' | 'checking';
type StepState = { state: 'pending' } | { state: 'running'; attempt: number } | { state: 'done' };

export interface FarInstallSheetProps {
  request: InstallRequest;
  api?: AgentInstallApi;
  sleep?: (ms: number) => Promise<void>;
  /** Puts text on the clipboard; false when it could not. */
  copy?: (text: string) => Promise<boolean>;
  openPage?: (url: string) => void;
  /** Shows this PC's New agent page (where "Ask my agent" is pasted). */
  askAgent?: (text: string) => void;
}

const nap = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const clip = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
};

/** What an agent on this PC is given: the goal, then what went wrong, fenced and marked as data from another PC. */
export function askAgentText(goal: string, why: string, untrusted: string, errorLabel: string): string {
  return `${goal}\n\n${untrusted}\n${errorLabel}\n-----\n${why.slice(0, 600)}\n-----\n`;
}

export function FarInstallSheet({ request, api: apiGiven, sleep = nap, copy = clip, openPage = (u) => void tauri.openExternalUrl(u), askAgent }: FarInstallSheetProps) {
  const t = useT();
  const { host, agentId } = request;
  const pc = host.place.kind === 'pc' ? host.place.name : '';
  const api = apiGiven ?? farInstallApi(host);
  const [phase, setPhase] = useState<Phase>('loading');
  const [plan, setPlan] = useState<InstallPlan | null>(null);
  const [trusted, setTrusted] = useState(false);
  const [steps, setSteps] = useState<StepState[]>([]);
  const [windowId, setWindowId] = useState<string | null>(null);
  const [showWindow, setShowWindow] = useState(false);
  const [shell, setShell] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [lastError, setLastError] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const stopped = useRef(false);
  const settled = useRef(false);
  const label = plan?.label || agentId;

  const done = (result: EnsureResult) => {
    if (settled.current) return;
    settled.current = true;
    request.finish(result);
  };
  useEffect(() => {
    stopped.current = false;
    return () => {
      stopped.current = true;
    };
  }, []);

  useEffect(() => {
    let live = true;
    api
      .plan(agentId)
      .then((p) => {
        if (!live) return;
        setPlan(p);
        setSteps(p.steps.map(() => ({ state: 'pending' as const })));
        setPhase('ask');
      })
      .catch((e) => {
        if (!live) return;
        setLastError(errorSentence(e));
        setPhase('ask');
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  const needsTrust = !!plan?.steps.some((s) => s.high_risk);
  const trustHost = plan?.steps.find((s) => s.high_risk)?.source_host ?? '';

  const handOver = async (why: string) => {
    setLastError(why);
    setProblem(null);
    setPhase('hand');
    if (shell) return;
    try {
      // The far PC opens a shell only in a project it knows: its most recent one.
      const recent = await host.invoke<{ path: string }[]>('project_recent', {});
      const project = recent[0]?.path.replace(/^remote:/, '');
      if (!project) {
        setProblem(t('farInstall.noProject', { pc }));
        return;
      }
      setShell(await host.invoke<string>('spawn_pane', { args: { agent_type: 'shell', cwd: project } }));
    } catch (e) {
      setProblem(t('farInstall.noWindow', { pc, why: errorSentence(e) }));
    }
  };

  const install = async () => {
    if (!plan || !plan.available || plan.steps.length === 0) {
      await handOver(plan?.reason ?? lastError);
      return;
    }
    setPhase('running');
    const outcome = await runFarInstall(agentId, plan, trusted, {
      api,
      sleep,
      cancelled: () => stopped.current,
      report: (p: StepProgress) => {
        if (p.kind === 'pane') setWindowId(p.paneId);
        else setSteps((all) => all.map((s, i) => (i !== p.index ? s : p.kind === 'try' ? { state: 'running', attempt: p.attempt } : { state: 'done' })));
      },
    });
    if (outcome === 'stopped' || stopped.current) return;
    if (outcome.ok && (await checkOnFar(host, api, agentId).catch(() => false))) {
      done('ready');
      return;
    }
    await handOver(outcome.ok ? t('farInstall.stillMissingWhy') : outcome.message);
  };

  const press = async () => {
    setPhase('checking');
    const ok = await checkOnFar(host, api, agentId).catch(() => false);
    if (ok) {
      if (shell) void host.invoke('kill_pane_cmd', { paneId: shell }).catch(() => undefined);
      done('ready');
      return;
    }
    setProblem(t('farInstall.stillMissing', { agent: label, pc, why: t('farInstall.stillMissingWhy') }));
    setPhase('hand');
  };

  const copyText = async (key: string, text: string) => {
    if (await copy(text)) {
      setCopied(key);
      setTimeout(() => setCopied((k) => (k === key ? null : k)), 1500);
    }
  };

  const ask = async () => {
    const text = askAgentText(t('farInstall.askGoal', { agent: label, pc }), lastError || problem || '', t('farInstall.askUntrusted'), t('farInstall.askError'));
    await copy(text);
    askAgent?.(text);
    setNote(t('farInstall.askAgentCopied'));
  };

  const command = plan?.steps[0]?.command ?? plan?.hint ?? null;
  const link = plan?.steps[0]?.source ?? (plan as (InstallPlan & { source?: string | null }) | null)?.source ?? null;
  const denied = host.denied?.('terminal') ?? null;

  if (phase === 'loading') {
    return (
      <Sheet labelledBy="ck-farinstall-t" onClose={() => done('cancelled')} className="ck-sheet--farinstall">
        <h2 className="ck-section" id="ck-farinstall-t">
          {t('farInstall.askTitle', { agent: label, pc })}
        </h2>
        <p className="ck-sub">{t('farInstall.checking', { pc })}</p>
      </Sheet>
    );
  }

  if (phase === 'ask') {
    return (
      <Sheet labelledBy="ck-farinstall-t" onClose={() => done('cancelled')} className="ck-sheet--farinstall">
        <h2 className="ck-section" id="ck-farinstall-t">
          {t('farInstall.askTitle', { agent: label, pc })}
        </h2>
        <p className="ck-sub">{t('farInstall.askBody', { agent: label, pc })}</p>
        {needsTrust && (
          <label className="ck-install-risk">
            <input type="checkbox" checked={trusted} onChange={(e) => setTrusted(e.target.checked)} />
            <span>{t('farInstall.trust', { host: trustHost })}</span>
          </label>
        )}
        {denied && <p className="ck-sub ck-doctor-error">{denied}</p>}
        <div className="ck-sheet-actions">
          <button type="button" className="ck-btn ck-btn--secondary" onClick={() => done('cancelled')}>
            {t('farInstall.notNow')}
          </button>
          <button type="button" className="ck-btn ck-btn--primary" autoFocus disabled={!!denied || (needsTrust && !trusted)} onClick={() => void install()}>
            {t('farInstall.install')}
          </button>
        </div>
      </Sheet>
    );
  }

  if (phase === 'running') {
    return (
      <Sheet labelledBy="ck-farinstall-t" className="ck-sheet--farinstall">
        <h2 className="ck-section" id="ck-farinstall-t">
          {t('farInstall.runTitle', { agent: label, pc })}
        </h2>
        <ol className="ck-farinstall-steps" data-testid="farinstall-steps">
          {plan?.steps.map((s, i) => {
            const st = steps[i] ?? { state: 'pending' };
            return (
              <li key={s.index} data-state={st.state}>
                <span className="ck-farinstall-step">{s.label}</span>
                <span className="ck-sub">
                  {st.state === 'pending' && t('farInstall.stepPending')}
                  {st.state === 'running' && (st.attempt > 1 ? `${t('farInstall.stepRetry')} ` : '') + t('farInstall.stepRunning', { n: st.attempt, max: 3 })}
                  {st.state === 'done' && t('farInstall.stepDone')}
                </span>
              </li>
            );
          })}
        </ol>
        {showWindow && windowId && (
          <div className="ck-farinstall-term">
            <FarTerminal name={pc} paneId={windowId} row={{ agent: 'shell', status: 'running', cwd: '' }} host={host} />
          </div>
        )}
        <div className="ck-sheet-actions">
          <button type="button" className="ck-btn ck-btn--plain" disabled={!windowId} onClick={() => setShowWindow((v) => !v)}>
            {showWindow ? t('farInstall.hideWindow') : t('farInstall.showWindow')}
          </button>
          <button type="button" className="ck-btn ck-btn--secondary" onClick={() => {
              stopped.current = true;
              done('cancelled');
            }}>
            {t('farInstall.cancel')}
          </button>
        </div>
      </Sheet>
    );
  }

  // The hand-over (and the check after Done).
  return (
    <Sheet labelledBy="ck-farinstall-t" className="ck-sheet--farinstall" onClose={phase === 'checking' ? undefined : () => done('cancelled')}>
      <h2 className="ck-section" id="ck-farinstall-t">
        {t('farInstall.handTitle', { agent: label, pc })}
      </h2>
      <p className="ck-sub">{command ? t('farInstall.handBody', { pc }) : t('farInstall.handBodyLink', { agent: label, pc })}</p>
      {command && (
        <div className="ck-farinstall-copy">
          <span className="ck-sub">{t('farInstall.command')}</span>
          <code className="ck-doctor-cmd" data-testid="farinstall-command">
            {command}
          </code>
          <button type="button" className="ck-btn ck-btn--plain" onClick={() => void copyText('cmd', command)}>
            {copied === 'cmd' ? t('farInstall.copied') : t('farInstall.copy')}
          </button>
        </div>
      )}
      {link && (
        <div className="ck-farinstall-copy">
          <span className="ck-sub">{t('farInstall.link')}</span>
          <code className="ck-doctor-cmd" data-testid="farinstall-link">
            {link}
          </code>
          <button type="button" className="ck-btn ck-btn--plain" onClick={() => void copyText('link', link)}>
            {copied === 'link' ? t('farInstall.copied') : t('farInstall.copy')}
          </button>
          <button type="button" className="ck-btn ck-btn--plain" onClick={() => openPage(link)}>
            {t('farInstall.openPage')}
          </button>
        </div>
      )}
      {shell && (
        <div className="ck-farinstall-term" data-testid="farinstall-shell">
          <FarTerminal name={pc} paneId={shell} row={{ agent: 'shell', status: 'running', cwd: '' }} host={host} />
        </div>
      )}
      {problem && (
        <p className="ck-sub ck-doctor-error" role="status" data-testid="farinstall-problem">
          {problem}
        </p>
      )}
      {note && (
        <p className="ck-sub" role="status" data-testid="farinstall-note">
          {note}
        </p>
      )}
      <div className="ck-sheet-actions">
        <button type="button" className="ck-btn ck-btn--plain" disabled={phase === 'checking'} onClick={() => void ask()}>
          {t('farInstall.askAgent')}
        </button>
        <button type="button" className="ck-btn ck-btn--secondary" disabled={phase === 'checking'} onClick={() => done('cancelled')}>
          {t('farInstall.notNow')}
        </button>
        <button type="button" className="ck-btn ck-btn--primary" autoFocus disabled={phase === 'checking'} onClick={() => void press()}>
          {phase === 'checking' ? t('farInstall.checking', { pc }) : t('farInstall.done')}
        </button>
      </div>
    </Sheet>
  );
}
