// Overview > "Fix everything": ONE button for the whole first-time set-up. It is the same job the welcome's "Set up
// everything" does (firstrun/setup-everything.ts: the chat add-ons, Potato Workspace added to the agents, two agents kept
// ready). A step that fails is tried again by itself, three tries in all; then the shared SetupStepBlock offers
// "Let <agent> fix it", which gives the job and what was printed to the person's own agent. No command is ever shown.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n';
import { requestAddAgentAction } from '../../lib/addAgentActions';
import { agentHealthApi } from '../../lib/agent-health';
import { agentPackApi } from '../../lib/agent-pack';
import { tauriAcpAddonApi } from '../../lib/acpAddon';
import type { AcpLaneView } from '../../lib/acpChat';
import { loadAgentView, pickHandoffAgent } from '../../lib/workerUpdate';
import { SetupStepBlock } from '../common/SetupStepBlock';
import { T } from '../firstrun/copy';
import { usableAgents, type ReadyAgent } from '../firstrun/model';
import { asSetupSteps, everythingTask, runSetupEverything, type EverythingApis, type EverythingRun, type EverythingStep, type EverythingStepId } from '../firstrun/setup-everything';
import { warmApi } from '../firstrun/warm';
import { Btn } from './settings-ui';

/** Where "Fix everything" gets its work and its helpers. The app uses the defaults; tests pass fakes. */
export interface FixEverythingSources {
  apis: EverythingApis;
  /** The agents found on this PC that can be set up (installed, not waiting for a sign-in). */
  agents: () => Promise<ReadyAgent[]>;
  /** The pause before a failed step runs again (tests give 0). */
  pauseMs?: number;
  loadAgents?: () => Promise<AcpLaneView | null>;
  handOff?: typeof requestAddAgentAction;
}

export const DEFAULT_FIX_EVERYTHING: FixEverythingSources = {
  apis: { addons: tauriAcpAddonApi, pack: agentPackApi, warm: warmApi },
  agents: async () => usableAgents(await agentHealthApi.check()),
};

type Handoff = { kind: 'none' } | { kind: 'sent'; agent: string } | { kind: 'none-found' };

const labels = (): Record<EverythingStepId, string> => ({ addons: T.stepAddons, connect: T.stepConnect, ready: T.stepReady });

export function FixEverything({ sources = DEFAULT_FIX_EVERYTHING, project, needed, onDone }: { sources?: FixEverythingSources; project: string | null; needed: boolean; onDone: () => void }) {
  const t = useT();
  const [steps, setSteps] = useState<EverythingStep[] | null>(null);
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState<EverythingRun | null>(null);
  const [handoff, setHandoff] = useState<Handoff>({ kind: 'none' });
  const [fixAgent, setFixAgent] = useState<{ id: string; label: string } | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const loadAgents = sources.loadAgents ?? loadAgentView;
  const handOff = sources.handOff ?? requestAddAgentAction;

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

  const start = useCallback(async () => {
    setRunning(true);
    setFinished(null);
    setHandoff({ kind: 'none' });
    const ready = await sources.agents().catch(() => [] as ReadyAgent[]);
    const run = await runSetupEverything({
      apis: sources.apis,
      ready,
      project,
      pauseMs: sources.pauseMs,
      isCancelled: () => !alive.current,
      onChange: (next) => alive.current && setSteps(next),
    });
    if (!alive.current) return;
    setRunning(false);
    setFinished(run);
    onDone(); // the cards and the list read the checks again
  }, [sources, project, onDone]);

  const fix = () => {
    if (!finished || finished.ok) return;
    if (!fixAgent) {
      setHandoff({ kind: 'none-found' });
      return;
    }
    handOff('chat', fixAgent.id, everythingTask(finished, labels()));
    setHandoff({ kind: 'sent', agent: fixAgent.label });
  };

  const failed = finished && !finished.ok ? finished.failed : null;
  const shownSteps = steps ? asSetupSteps(steps, labels()) : null;
  if (!needed && !shownSteps) return null;
  return (
    <section className="st-fixall" data-testid="fix-everything" aria-label={t('overview.fixEverything.button')}>
      {!shownSteps && <p className="st-fixall-lead">{t('overview.fixEverything.lead')}</p>}
      {!failed && (
        <Btn primary data-testid="fix-everything-go" disabled={running} onClick={() => void start()}>
          {running ? t('overview.fixEverything.working') : t('overview.fixEverything.button')}
        </Btn>
      )}
      {shownSteps && (
        <SetupStepBlock
          testId="fix-everything"
          steps={shownSteps}
          failedId={failed}
          onFix={failed ? fix : undefined}
          fixAgent={fixAgent}
          handed={handoff.kind === 'sent' ? T.handedOver(handoff.agent) : handoff.kind === 'none-found' ? T.noAgentToFix : null}
          onRetry={failed ? () => void start() : undefined}
          done={finished?.ok ? t('overview.fixEverything.done') : null}
        />
      )}
    </section>
  );
}
