// The first-run welcome: four short steps and a done screen over the cockpit, shown once on a fresh
// profile, skippable at every step, and reopened from the palette or Settings. It draws `model.ts`; the
// choices that matter reach Rust through the ordinary settings patch (look, step, folder). The last step
// opens a real agent pane (the demo) and watches it; the clock in `timing.ts` runs to its first result.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { CockpitApi } from '../../hooks/useCockpit';
import { agentLabel, useAgentRegistry } from '../../lib/agentRegistry';
import { agentHealthApi, type AgentHealthApi } from '../../lib/agent-health';
import { agentInstallApi, type AgentInstallApi } from '../../lib/agent-install';
import { agentPackApi, type AgentPackApi } from '../../lib/agent-pack';
import { loadSettings, patchSettings } from '../../lib/settings';
import { shipApi, type ShipApi } from '../../lib/ship-api';
import { simpleApi, type SimpleApi } from '../simple/simple-api';
import { DotSpinner } from '../cockpit/DotSpinner';
import '../../styles/first-run.css';
import { T } from './copy';
import { demoApi, type DemoApi } from './demo-api';
import {
  agentPatch,
  canContinue,
  demoFinished,
  demoHelpers,
  initialFlow,
  lookPatch,
  planDemo,
  projectPatch,
  reduce,
  stepIndex,
  stepPatch,
  STEPS,
  warmTargets,
  type Look,
  type MoreId,
  type StepId,
} from './model';
import { beginTiming, readTiming, recordFirstResult } from './timing';
import type { Seed } from './useFirstRun';
import { startWarming, warmApi, type WarmApi } from './warm';
import { StepAgents } from './StepAgents';
import { StepConnect } from './StepConnect';
import { StepProject } from './StepProject';
import { NO_TASK, StepTask, type TaskView } from './StepTask';
import { StepDone, StepPack, StepPhone } from './StepsSmall';
import { useModalLayer } from './useModalLayer';

/** What the welcome talks to. Tests and the harness pass fakes; the app passes nothing. */
export interface FirstRunDeps {
  ship: Pick<ShipApi, 'recent' | 'pickFolder' | 'forget' | 'gitInitPlan' | 'gitInit'>;
  simple: Pick<SimpleApi, 'checkFolder'>;
  patch: typeof patchSettings;
  load: typeof loadSettings;
  health?: AgentHealthApi;
  install?: AgentInstallApi;
  pack?: AgentPackApi;
  /** Opens the demo pane and sends the prompt. */
  demo: DemoApi;
  /** The warm agent pool (Settings > Preload). */
  warm: WarmApi;
}

export function defaultDeps(): FirstRunDeps {
  return { ship: shipApi, simple: simpleApi, patch: patchSettings, load: loadSettings, health: agentHealthApi, install: agentInstallApi, pack: agentPackApi, demo: demoApi, warm: warmApi };
}

/** Runs `fn` when `value` differs from the last render's, never on the first render. */
function useWhenChanged<V>(value: V, fn: (value: V) => void): void {
  const last = useRef(value);
  useEffect(() => {
    if (Object.is(last.current, value)) return;
    last.current = value;
    fn(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
}

function Progress({ step }: { step: StepId }) {
  const at = stepIndex(step);
  return (
    <ol className="fr-dots" aria-label={T.stepOf(at + 1, STEPS.length)}>
      {STEPS.map((id, i) => (
        <li key={id} className="fr-dot" data-state={i < at ? 'done' : i === at ? 'now' : 'next'} title={T.stepNames[id]} />
      ))}
    </ol>
  );
}

export function FirstRun({ c, seed, onFinish, deps }: { c: CockpitApi; seed: Seed; onFinish: () => void; deps?: Partial<FirstRunDeps> }) {
  const d: FirstRunDeps = { ...defaultDeps(), ...deps };
  const dRef = useRef(d);
  dRef.current = d;
  const listing = useAgentRegistry();
  const [flow, dispatch] = useReducer(reduce, undefined, () =>
    initialFlow({
      step: seed.start,
      look: seed.look,
      project: seed.project,
      ready: seed.agentId ? [{ id: seed.agentId, label: agentLabel(listing, seed.agentId) }] : [],
    }),
  );
  // Paused: the person went to a window (sign in, an install) and the welcome waits as a small bar.
  const [docked, setDocked] = useState(false);
  const [taskView, setTaskView] = useState<TaskView>(NO_TASK);
  const [warming, setWarming] = useState(false);
  // A screen reached from Done (phone, skills); null: the main path.
  const [more, setMore] = useState<MoreId | null>(null);
  // A real modal: the cockpit behind is inert, Tab stays inside, Esc leaves, focus goes back when it closes.
  const layerRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const modal = useModalLayer({ layer: layerRef, shell: shellRef, active: !docked, onEscape: () => dispatch({ type: 'skipAll' }) });

  const save = useCallback((patch: Record<string, unknown>) => {
    void dRef.current.patch(patch as never).catch(() => undefined);
  }, []);

  // The clock for "first result in under 3 minutes". A resumed welcome keeps its clock. Local only.
  useEffect(() => {
    beginTiming(Date.now(), seed.start !== STEPS[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Where the person is, so a restart resumes there. Nothing is written until something changes.
  useWhenChanged(flow.step, (step) => save(stepPatch(step)));
  // A new screen: focus goes to the window so a screen reader starts at its top.
  useWhenChanged(`${more ?? flow.step}`, () => shellRef.current?.focus({ preventScroll: true }));
  useWhenChanged(flow.project?.path ?? '', () => save(projectPatch(flow.project)));
  useWhenChanged(flow.ready.map((a) => a.id).join(','), () => save(agentPatch(flow.ready)));

  const finishedOnce = useRef(false);
  useEffect(() => {
    if (flow.finished && !finishedOnce.current) {
      finishedOnce.current = true;
      onFinish();
    }
  }, [flow.finished, onFinish]);

  // Warm the main agent (and Codex, when it is there) for the likely project while the person reads.
  const targets = useMemo(() => warmTargets(flow.ready), [flow.ready]);
  const warmKey = `${targets.join(',')}|${flow.project?.path ?? ''}`;
  useEffect(() => {
    if (targets.length === 0) return;
    let alive = true;
    void (async () => {
      let project = flow.project?.path ?? null;
      if (!project) {
        const recent = await dRef.current.ship.recent().catch(() => []);
        project = recent.find((r) => r.state === 'repo')?.path ?? null;
      }
      const result = await startWarming(dRef.current.warm, targets, project);
      if (alive && result === 'started') setWarming(true);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [warmKey]);

  // A different folder starts the demo over.
  useEffect(() => {
    if (flow.task === 'idle' && taskView.pane) setTaskView(NO_TASK);
  }, [flow.task, taskView.pane]);

  // The demo keeps running (and being watched) when the person moves to another step. It is finished
  // when the main pane worked and stopped and the helpers it started have stopped.
  const plan = useMemo(() => planDemo(flow.ready), [flow.ready]);
  const demoPane = taskView.pane;
  const mainStatus = demoPane ? c.registry.panes.get(demoPane)?.status : undefined;
  const helperStatuses = demoHelpers(c.registry.paneList, demoPane).map((h) => h.status);
  const helperKey = helperStatuses.join(',');
  const idleFor = demoPane && mainStatus && mainStatus !== 'running' ? Math.max(0, c.now - (c.statusSince.get(demoPane) ?? c.now)) : 0;
  const hasHelper = plan?.helper != null;
  useEffect(() => {
    if (!demoPane || flow.task === 'done' || flow.task === 'skipped' || flow.task === 'failed') return;
    if (mainStatus === 'running' && !taskView.sawRunning) {
      setTaskView((v) => (v.pane === demoPane ? { ...v, sawRunning: true } : v));
      return;
    }
    const end = demoFinished(taskView.sawRunning, mainStatus, helperStatuses, hasHelper, idleFor);
    if (!end) return;
    if (end === 'alone') {
      // No helper started: not the demo, so no success and no time recorded.
      dispatch({ type: 'task', task: 'failed' });
      return;
    }
    const took = recordFirstResult(Date.now()) ?? readTiming()?.firstResultMs ?? null;
    setTaskView((v) => (v.pane === demoPane ? { ...v, tookMs: took } : v));
    dispatch({ type: 'task', task: 'done' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demoPane, mainStatus, helperKey, taskView.sawRunning, flow.task, idleFor, hasHelper]);

  const chooseLook = (look: Look) => {
    dispatch({ type: 'look', look });
    // Written now; the cockpit keeps its normal face until the welcome closes (CockpitApp).
    save({ ...lookPatch(look) });
  };

  const dock = (then?: () => void) => {
    setDocked(true);
    then?.();
  };

  const step = flow.step;
  const last = step === 'done';
  const primaryLabel = last ? T.doneButton : T.next;

  return (
    <div ref={layerRef} className="fr-layer" data-docked={docked ? 'true' : undefined} data-testid="first-run" onKeyDown={modal.onKeyDown}>
      {docked && (
        <div className="fr-bar" role="status">
          <DotSpinner status="waiting_input" />
          <span>{T.pausedBar}</span>
          <button type="button" className="ck-btn ck-btn--primary ck-btn--sm" onClick={() => setDocked(false)}>
            {T.pausedButton}
          </button>
        </div>
      )}
      <div ref={shellRef} className="fr-shell" role="dialog" aria-modal="true" aria-label={T.title} tabIndex={-1} hidden={docked}>
        <header className="fr-top">
          <Progress step={step} />
          <span className="fr-stepof">{T.stepOf(stepIndex(step) + 1, STEPS.length)}</span>
        </header>

        <main className="fr-body" key={more ?? step}>
          {more === 'phone' && <StepPhone load={d.load} patch={d.patch} />}
          {more === 'pack' && <StepPack api={d.pack} />}
          {more === null && step === 'agents' && (
            <StepAgents
              ready={flow.ready}
              warming={warming}
              api={d.health}
              installApi={d.install}
              onReady={(ready) => dispatch({ type: 'agents', ready })}
              onNotify={c.notify}
              onSignIn={(id) => dock(() => void c.newAgent(id))}
              onShowPane={(id) => dock(() => c.select(id))}
            />
          )}
          {more === null && step === 'connect' && (
            <StepConnect api={d.pack} connected={flow.connected} onConnected={(connected) => dispatch({ type: 'connected', connected })} />
          )}
          {more === null && step === 'project' && (
            <StepProject project={flow.project} ship={d.ship} simple={d.simple} onProject={(project) => dispatch({ type: 'project', project })} />
          )}
          {more === null && step === 'task' && (
            <StepTask
              c={c}
              flow={flow}
              plan={plan}
              view={taskView}
              demo={d.demo}
              warm={d.warm}
              onView={setTaskView}
              onTask={(task) => dispatch({ type: 'task', task })}
              onGo={(to) => dispatch({ type: 'go', step: to })}
              onOpenPane={(id) => dock(() => c.select(id))}
            />
          )}
          {more === null && step === 'done' && <StepDone onMore={setMore} packDone={flow.connected === 'yes'} look={flow.look} onLook={chooseLook} />}
        </main>

        <footer className="fr-foot">
          <button
            type="button"
            className="ck-btn ck-btn--plain"
            disabled={more === null && stepIndex(step) === 0}
            onClick={() => (more !== null ? setMore(null) : dispatch({ type: 'back' }))}
          >
            {T.back}
          </button>
          <span className="fr-foot-gap" />
          {!last && (
            <button type="button" className="ck-btn ck-btn--secondary" onClick={() => dispatch({ type: 'skip' })}>
              {T.skipStep}
            </button>
          )}
          <button type="button" className="ck-btn ck-btn--primary" disabled={more === null && !canContinue(flow)} onClick={() => (more !== null ? onFinish() : dispatch({ type: 'next' }))}>
            {more !== null ? T.doneButton : primaryLabel}
          </button>
        </footer>
        <p className="fr-reopen">{T.reopenNote}</p>
      </div>
    </div>
  );
}
