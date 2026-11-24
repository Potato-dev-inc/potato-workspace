// The first-run welcome: two screens over the cockpit, shown once on a fresh profile, skippable, reopened from
// the palette, Settings or the "Finish setup" chip. It draws `model.ts`; the choices that matter reach Rust through
// the ordinary settings patch (step, folder). Screen 1 "Your agents" has one button, "Set up everything"; screen 2
// picks a project folder or says "Skip for now". Nothing is locked: what is not done is finished later.
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { CockpitApi } from '../../hooks/useCockpit';
import { agentLabel, useAgentRegistry } from '../../lib/agentRegistry';
import { agentHealthApi, type AgentHealthApi } from '../../lib/agent-health';
import { agentInstallApi, type AgentInstallApi } from '../../lib/agent-install';
import { agentPackApi, type AgentPackApi } from '../../lib/agent-pack';
import { tauriAcpAddonApi, type AcpAddonApi } from '../../lib/acpAddon';
import type { AcpLaneView } from '../../lib/acpChat';
import { loadSettings, patchSettings } from '../../lib/settings';
import { shipApi, type ShipApi } from '../../lib/ship-api';
import { simpleApi, type SimpleApi } from '../simple/simple-api';
import { DotSpinner } from '../cockpit/DotSpinner';
import { useT } from '../../i18n';
import '../../styles/first-run.css';
import { T } from './copy';
import { agentPatch, initialFlow, projectPatch, reduce, setupPending, stepIndex, stepPatch, STEPS, type StepId } from './model';
import type { Seed } from './useFirstRun';
import { startWarming, warmApi, type WarmApi } from './warm';
import { StepAgents } from './StepAgents';
import { StepProject } from './StepProject';
import { useModalLayer } from './useModalLayer';

/** What the welcome talks to. Tests and the harness pass fakes; the app passes nothing. */
export interface FirstRunDeps {
  ship: Pick<ShipApi, 'recent' | 'pickFolder' | 'forget'>;
  simple: Pick<SimpleApi, 'checkFolder'>;
  patch: typeof patchSettings;
  load: typeof loadSettings;
  health?: AgentHealthApi;
  install?: AgentInstallApi;
  pack?: AgentPackApi;
  /** The chat add-ons "Set up everything" installs. */
  addons?: AcpAddonApi;
  /** The warm agent pool (Settings > Preload). */
  warm: WarmApi;
  /** Who gets "Let <agent> fix it", and how the chat opens (tests pass fakes). */
  loadAgents?: () => Promise<AcpLaneView | null>;
  handOff?: (kind: 'chat', agentId: string, task: string) => void;
  /** The pause before a failed set-up step runs again (tests give 0). */
  pauseMs?: number;
}

export function defaultDeps(): FirstRunDeps {
  return { ship: shipApi, simple: simpleApi, patch: patchSettings, load: loadSettings, health: agentHealthApi, install: agentInstallApi, pack: agentPackApi, addons: tauriAcpAddonApi, warm: warmApi };
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
  useT();
  const at = stepIndex(step);
  return (
    <ol className="fr-dots" aria-label={T.stepOf(at + 1, STEPS.length)}>
      {STEPS.map((id, i) => (
        <li key={id} className="fr-dot" data-state={i < at ? 'done' : i === at ? 'now' : 'next'} title={T.stepNames[id]} />
      ))}
    </ol>
  );
}

export function FirstRun({ c, seed, onFinish, deps }: { c: CockpitApi; seed: Seed; onFinish: (pending: boolean) => void; deps?: Partial<FirstRunDeps> }) {
  useT(); // redraw when the language changes (the words come from `T`)
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
  // Paused: the person went to a window (sign in, a chat that fixes set-up) and the welcome waits as a small bar.
  const [docked, setDocked] = useState(false);
  const [warming, setWarming] = useState(false);
  // "Set up everything" finished (all three steps worked).
  const [setupDone, setSetupDone] = useState(false);
  // A real modal: the cockpit behind is inert, Tab stays inside, Esc leaves, focus goes back when it closes.
  const layerRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const modal = useModalLayer({ layer: layerRef, shell: shellRef, active: !docked, onEscape: () => dispatch({ type: 'skipAll' }) });

  const save = useCallback((patch: Record<string, unknown>) => {
    void dRef.current.patch(patch as never).catch(() => undefined);
  }, []);

  // Where the person is, so a restart resumes there. Nothing is written until something changes.
  useWhenChanged(flow.step, (step) => save(stepPatch(step)));
  // A new screen: focus goes to the window so a screen reader starts at its top.
  useWhenChanged(flow.step, () => shellRef.current?.focus({ preventScroll: true }));
  useWhenChanged(flow.project?.path ?? '', () => save(projectPatch(flow.project)));
  useWhenChanged(flow.ready.map((a) => a.id).join(','), () => save(agentPatch(flow.ready)));

  // Whether set-up is still open when the welcome closes, read when it does.
  const pending = setupPending(flow.project, setupDone);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const finishedOnce = useRef(false);
  useEffect(() => {
    if (flow.finished && !finishedOnce.current) {
      finishedOnce.current = true;
      onFinish(pendingRef.current);
    }
  }, [flow.finished, onFinish]);

  // After "Set up everything", the agents that are kept ready follow the folder the person picks.
  useEffect(() => {
    const path = flow.project?.path;
    if (!setupDone || !path) return;
    void startWarming(dRef.current.warm, [], path).catch(() => undefined);
  }, [setupDone, flow.project?.path]);

  const dock = (then?: () => void) => {
    setDocked(true);
    then?.();
  };

  const step = flow.step;
  const last = step === STEPS[STEPS.length - 1];
  // Screen 2 with no folder says "Skip for now"; a picked folder says "Done". Screen 1 says "Continue".
  const primaryLabel = !last ? T.next : flow.project ? T.doneNow : T.skipStep;

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
          {pending && (
            <span className="fr-chip" data-testid="finish-setup-chip" title={T.finishSetupHint}>
              {T.finishSetup}
            </span>
          )}
        </header>

        <main className="fr-body" key={step}>
          {step === 'agents' && (
            <StepAgents
              ready={flow.ready}
              warming={warming}
              api={d.health}
              installApi={d.install}
              apis={{ addons: d.addons ?? tauriAcpAddonApi, pack: d.pack ?? agentPackApi, warm: d.warm }}
              project={flow.project?.path ?? null}
              setupDone={setupDone}
              onSetupDone={() => {
                setSetupDone(true);
                setWarming(true);
              }}
              onHandedOff={() => dock()}
              loadAgents={d.loadAgents}
              handOff={d.handOff}
              pauseMs={d.pauseMs}
              onReady={(ready) => dispatch({ type: 'agents', ready })}
              onNotify={c.notify}
              onSignIn={(id) => dock(() => void c.newAgent(id))}
              onShowPane={(id) => dock(() => c.select(id))}
            />
          )}
          {step === 'project' && <StepProject project={flow.project} ship={d.ship} simple={d.simple} onProject={(project) => dispatch({ type: 'project', project })} />}
        </main>

        <footer className="fr-foot">
          {stepIndex(step) > 0 && (
            <button type="button" className="ck-btn ck-btn--plain" onClick={() => dispatch({ type: 'back' })}>
              {T.back}
            </button>
          )}
          <span className="fr-foot-gap" />
          <button type="button" className="ck-btn ck-btn--primary" data-testid="first-run-next" onClick={() => dispatch({ type: 'next' })}>
            {primaryLabel}
          </button>
        </footer>
        <p className="fr-reopen">{T.reopenNote}</p>
      </div>
    </div>
  );
}
