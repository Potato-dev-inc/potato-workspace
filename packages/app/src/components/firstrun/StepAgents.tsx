// Screen 1, "Your agents": every agent found on this PC, and one button, "Set up everything" (chat add-ons,
// connect, keep two ready: `setup-everything.ts`). Progress and a failure draw the shared SetupStepBlock, with
// "Let <agent> fix it". Only sign-in stays a button per agent, because the person signs in themselves.
// Install help is the Set up agents list, folded under "Help with an agent". Nothing is locked.
import { useCallback, useEffect, useRef, useState } from 'react';
import { agentHealthApi, type AgentHealth, type AgentHealthApi } from '../../lib/agent-health';
import type { AgentInstallApi } from '../../lib/agent-install';
import { AgentDoctor } from '../cockpit/AgentDoctor';
import { requestAddAgentAction } from '../../lib/addAgentActions';
import { loadAgentView, pickHandoffAgent } from '../../lib/workerUpdate';
import type { AcpLaneView } from '../../lib/acpChat';
import { AgentLogo } from '../common/AgentLogo';
import { SetupStepBlock } from '../common/SetupStepBlock';
import { useT } from '../../i18n';
import { T } from './copy';
import { usableAgents, WATCHED_AGENTS, type ReadyAgent } from './model';
import {
  asSetupSteps,
  everythingTask,
  runSetupEverything,
  type EverythingApis,
  type EverythingRun,
  type EverythingStep,
  type EverythingStepId,
} from './setup-everything';

type Row = Pick<AgentHealth, 'id' | 'label' | 'state' | 'installed'>;

/** The four watched agents, in a fixed order, from a full health list. */
export function watchedRows(rows: AgentHealth[]): AgentHealth[] {
  return WATCHED_AGENTS.flatMap((id) => rows.filter((r) => r.id === id).slice(0, 1));
}

function RowStatus({ row }: { row: Row }) {
  useT();
  if (row.state === 'not_installed' || !row.installed) return <>{T.agentMissing}</>;
  if (row.state === 'needs_login') return <>{T.agentLogin}</>;
  return <>{T.agentFound}</>;
}

export function StepAgents({
  ready,
  warming,
  api = agentHealthApi,
  installApi,
  onReady,
  onNotify,
  onSignIn,
  onShowPane,
  apis,
  project,
  setupDone,
  onSetupDone,
  onHandedOff,
  loadAgents = loadAgentView,
  handOff = requestAddAgentAction,
  pauseMs,
}: {
  ready: ReadyAgent[];
  /** Warm agents were started. */
  warming: boolean;
  /** What "Set up everything" talks to. */
  apis: EverythingApis;
  /** The folder warm agents start in, when one is known. */
  project: string | null;
  /** The run finished earlier (the screen was left and came back to). */
  setupDone: boolean;
  onSetupDone: () => void;
  /** The job went to an agent's chat: the welcome waits as a small bar. */
  onHandedOff: () => void;
  loadAgents?: () => Promise<AcpLaneView | null>;
  handOff?: (kind: 'chat', agentId: string, task: string) => void;
  /** The pause before a failed step runs again (tests give 0). */
  pauseMs?: number;
  api?: AgentHealthApi;
  installApi?: AgentInstallApi;
  onReady: (ready: ReadyAgent[]) => void;
  onNotify: (text: string) => void;
  /** Opens the agent in a window so the person can sign in; the welcome waits as a bar. */
  onSignIn: (agentId: string) => void;
  onShowPane: (paneId: string) => void;
}) {
  useT();
  const [rows, setRows] = useState<AgentHealth[] | null>(null);
  const [help, setHelp] = useState(false);
  const [steps, setSteps] = useState<EverythingStep[] | null>(null);
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState<EverythingRun | null>(null);
  const [handoff, setHandoff] = useState<{ kind: 'none' } | { kind: 'busy' } | { kind: 'sent'; agent: string } | { kind: 'none-found' }>({ kind: 'none' });
  const [fixAgent, setFixAgent] = useState<{ id: string; label: string } | null>(null);
  const alive = useRef(true);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  const apply = useCallback((all: AgentHealth[]) => {
    setRows(watchedRows(all));
    // Only the rows shown count, so "N agents are ready" matches the list.
    onReadyRef.current(usableAgents(watchedRows(all)));
  }, []);

  const check = useCallback(() => {
    api
      .check()
      .then((all) => alive.current && apply(all))
      .catch(() => alive.current && apply([]));
  }, [api, apply]);

  useEffect(() => {
    alive.current = true;
    check();
    return () => {
      alive.current = false;
    };
  }, [check]);

  // Back from a sign-in or install window: look again.
  useEffect(() => {
    window.addEventListener('focus', check);
    return () => window.removeEventListener('focus', check);
  }, [check]);

  const labels = (): Record<EverythingStepId, string> => ({ addons: T.stepAddons, connect: T.stepConnect, ready: T.stepReady });

  // Who would fix a failure: looked up when the failure shows, so the button can name the agent.
  useEffect(() => {
    if (!finished || finished.ok) return;
    let live = true;
    void loadAgents()
      .catch(() => null)
      .then((view) => live && setFixAgent(pickHandoffAgent(view)));
    return () => {
      live = false;
    };
  }, [finished, loadAgents]);

  const start = async () => {
    setRunning(true);
    setFinished(null);
    setHandoff({ kind: 'none' });
    const run = await runSetupEverything({
      apis,
      ready,
      project,
      pauseMs,
      isCancelled: () => !alive.current,
      onChange: (next) => alive.current && setSteps(next),
    });
    if (!alive.current) return;
    setRunning(false);
    setFinished(run);
    if (run.ok) onSetupDone();
  };

  const fix = () => {
    if (!finished || finished.ok) return;
    if (!fixAgent) {
      setHandoff({ kind: 'none-found' });
      return;
    }
    handOff('chat', fixAgent.id, everythingTask(finished, labels()));
    setHandoff({ kind: 'sent', agent: fixAgent.label });
    onHandedOff();
  };

  const failed = finished && !finished.ok ? finished.failed : null;
  const allDone = setupDone || finished?.ok === true;
  const blockSteps = steps ? asSetupSteps(steps, labels()) : null;

  return (
    <section className="fr-step" aria-labelledby="fr-agents-t">
      <h1 className="ck-title" id="fr-agents-t">{T.agentsTitle}</h1>
      <p className="fr-lead">{T.agentsLead}</p>

      <ul className="fr-agentlist" data-testid="agent-rows">
        {rows === null && <li className="fr-agentrow fr-agentrow--plain fr-hint">{T.agentChecking}</li>}
        {rows?.map((r) => {
          const missing = r.state === 'not_installed' || !r.installed;
          const login = !missing && r.state === 'needs_login';
          return (
            <li key={r.id} className="fr-agentrow" data-state={missing ? 'missing' : login ? 'login' : 'ready'}>
              <AgentLogo id={r.id} name={r.label} size={16} decorative />
              <span className="fr-agentname">{r.label}</span>
              <span className="fr-agentstate">
                <RowStatus row={r} />
              </span>
              {missing && (
                <button type="button" className="ck-btn ck-btn--secondary ck-btn--sm" onClick={() => setHelp(true)}>
                  {T.agentInstall}
                </button>
              )}
              {login && (
                <button type="button" className="ck-btn ck-btn--secondary ck-btn--sm" onClick={() => onSignIn(r.id)}>
                  {T.agentSignIn}
                </button>
              )}
            </li>
          );
        })}
      </ul>

      <p className="fr-status" role="status" data-ready={ready.length > 0 ? 'true' : 'false'}>
        {rows === null ? T.agentChecking : ready.length > 0 ? T.agentsReady(ready.length) : T.agentsNone}
      </p>

      {!allDone && <p className="fr-hint">{T.setUpLead}</p>}
      {!allDone && !failed && (
        <div className="fr-actions">
          <button type="button" className="ck-btn ck-btn--primary" data-testid="set-up-everything" disabled={running || rows === null || ready.length === 0} onClick={() => void start()}>
            {running ? T.setUpWorking : T.setUpEverything}
          </button>
        </div>
      )}
      {blockSteps && (
        <SetupStepBlock
          testId="first-run-setup"
          steps={blockSteps}
          failedId={failed}
          onFix={failed ? fix : undefined}
          fixAgent={fixAgent}
          fixing={handoff.kind === 'busy'}
          handed={handoff.kind === 'sent' ? T.handedOver(handoff.agent) : handoff.kind === 'none-found' ? T.noAgentToFix : null}
          onRetry={failed ? () => void start() : undefined}
          done={allDone ? T.setUpDone : null}
        />
      )}
      {allDone && !blockSteps && (
        <p className="fr-status" role="status" data-testid="first-run-setup-done">
          {T.setUpDone}
        </p>
      )}

      <div className="fr-actions">
        <button type="button" className="ck-btn ck-btn--plain ck-btn--sm" aria-expanded={help} onClick={() => setHelp((h) => !h)}>
          {T.agentsMore}
        </button>
      </div>
      {help && warming && <p className="fr-hint" data-testid="warming-note">{T.agentsWarm}</p>}
      {help && (
        <AgentDoctor
          embedded
          api={api}
          installApi={installApi}
          onRows={apply}
          onNotify={onNotify}
          onOpenAgent={onSignIn}
          onShowPane={onShowPane}
        />
      )}
    </section>
  );
}
