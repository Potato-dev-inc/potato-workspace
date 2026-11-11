// Step 4: Try it. One click opens the main agent in the chosen project and sends the demo prompt. The
// agent asks a second agent for help; its pane appears nested under the first in the sidebar, and the
// helpers show here as they work. An agent that asks first shows the same approval card as everywhere
// else. With only one agent ready, the demo is a plain read-only question instead.
import { useEffect, useState } from 'react';
import type { CockpitApi } from '../../hooks/useCockpit';
import { helperStatus, HELPER_STATUS_LABEL } from '../../lib/chat-helpers';
import { ApprovalPrompt } from '../cockpit/ApprovalPrompt';
import { QuestionCard } from '../cockpit/QuestionCard';
import { DotSpinner } from '../cockpit/DotSpinner';
import { formatElapsed } from '../cockpit/model';
import { demoPrompt, T, TASK_PROMPT } from './copy';
import type { DemoApi } from './demo-api';
import { waitForWarm, type WarmApi } from './warm';
import { demoHelpers, demoQuestions, shortAgentName, withoutDuplicateAsks, type DemoPlan, type Flow, type StepId } from './model';

/** The demo as the shell keeps it, so it survives a trip to another step. */
export interface TaskView {
  /** The main agent's pane; null before the click. */
  pane: string | null;
  /** The main pane has been seen working. */
  sawRunning: boolean;
  startedAt: number;
  /** How long the first result took, once it has. */
  tookMs: number | null;
  /** The agent opened from a warm worker (true) or started cold (false). */
  warm: boolean | null;
}

export const NO_TASK: TaskView = { pane: null, sawRunning: false, startedAt: 0, tookMs: null, warm: null };

/** The words sent to the main agent. */
export const promptFor = (plan: DemoPlan): string => (plan.helper ? demoPrompt(shortAgentName(plan.helper.label)) : TASK_PROMPT);

function useSecond(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [on]);
  return now;
}

export function StepTask({
  c,
  flow,
  plan,
  view,
  demo,
  warm,
  onView,
  onTask,
  onGo,
  onOpenPane,
}: {
  c: CockpitApi;
  flow: Flow;
  plan: DemoPlan | null;
  view: TaskView;
  demo: DemoApi;
  warm: WarmApi;
  onView: (next: TaskView) => void;
  onTask: (task: Flow['task']) => void;
  onGo: (step: StepId) => void;
  onOpenPane: (paneId: string) => void;
}) {
  const project = flow.project;
  const [starting, setStarting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // The exact words are behind a button: most people only need the plain summary.
  const [exact, setExact] = useState(false);
  /** The agent opened but cannot reach this app's MCP bridge: the demo was not sent. */
  const [noMcp, setNoMcp] = useState(false);
  const done = flow.task === 'done';
  const alone = flow.task === 'failed' && view.pane !== null;
  const working = view.pane !== null && !done && !alone;
  const now = useSecond(working || starting);
  const [openedAt, setOpenedAt] = useState(0);

  const start = async () => {
    if (!project || !plan) return;
    setStarting(true);
    setOpenedAt(Date.now());
    setProblem(null);
    setNoMcp(false);
    try {
      // A warm worker may still be starting in this folder: give it a moment, so the demo claims it.
      await waitForWarm(warm, project.path, plan.main.id);
      const opened = await demo.start(c, plan.main.id, project.path, promptFor(plan), plan.helper !== null);
      if (!opened) {
        setProblem(T.taskPaneFailed);
        return;
      }
      if (!opened.mcp) {
        setNoMcp(true);
        return;
      }
      onView({ pane: opened.paneId, sawRunning: false, startedAt: Date.now(), tookMs: null, warm: opened.warm });
      onTask('running');
    } catch {
      setProblem(T.taskPaneFailed);
    } finally {
      setStarting(false);
    }
  };

  /** Start over: a fresh pane and the same prompt. */
  const again = () => {
    onView(NO_TASK);
    onTask('idle');
    setProblem(null);
    setNoMcp(false);
  };

  const head = (
    <>
      <div className="ck-doto fr-num" aria-hidden="true">04</div>
      <h1 className="ck-title" id="fr-task-t">{T.taskTitle}</h1>
      <p className="fr-lead">{T.taskLead}</p>
    </>
  );

  // No agent or no folder: say what is missing and where to get it.
  if (!plan || !project) {
    return (
      <section className="fr-step" aria-labelledby="fr-task-t">
        {head}
        <p className="fr-hint" role="status">{!plan ? T.taskNeedsAgent : T.taskNeedsProject}</p>
        <div className="fr-actions">
          <button type="button" className="ck-btn ck-btn--secondary" onClick={() => onGo(!plan ? 'agents' : 'project')}>
            {T.stepNames[!plan ? 'agents' : 'project']}
          </button>
        </div>
      </section>
    );
  }

  const pane = view.pane;
  const helpers = demoHelpers(c.registry.paneList, pane);
  const mainStatus = pane ? c.registry.panes.get(pane)?.status : undefined;
  const asking = [pane, ...helpers.map((h) => h.info.id)].flatMap((id) => {
    const p = id ? c.prompts[id] : null;
    return id && p && p.risk && p.choices.length > 0 ? [{ id, prompt: p }] : [];
  });

  // Questions the demo waits on (a helper's "which login?", an agent's ask_user): shown here with their buttons.
  const helperCardShown = helpers.some((h) => (c.prompts[h.info.id]?.choices.length ?? 0) > 0);
  const cards =
    pane && !done && !alone
      ? withoutDuplicateAsks(demoQuestions(c.asked.questions, [pane, ...helpers.map((h) => h.info.id)], view.startedAt), helperCardShown, pane)
      : [];
  const waiting = asking.length + cards.length > 0;

  return (
    <section className="fr-step" aria-labelledby="fr-task-t">
      {head}

      {!pane && (
        <>
          <h2 className="fr-cap">{T.taskWhat}</h2>
          <p className="fr-answer" data-testid="task-summary">
            {T.taskSummary(shortAgentName(plan.main.label), plan.helper ? shortAgentName(plan.helper.label) : null)}
          </p>
          <button type="button" className="ck-btn ck-btn--plain ck-btn--sm fr-ask-toggle" aria-expanded={exact} aria-controls="fr-exact" onClick={() => setExact((v) => !v)}>
            {T.taskExact}
          </button>
          <blockquote className="fr-ask" id="fr-exact" data-testid="task-prompt" hidden={!exact}>
            {promptFor(plan)}
          </blockquote>
          {!plan.helper && <p className="fr-hint" data-testid="task-solo">{T.taskSolo}</p>}
          {problem && (
            <p className="fr-problem" role="alert">
              {problem}
            </p>
          )}
          {noMcp && (
            <div className="fr-problem" role="alert" data-testid="task-no-mcp">
              <p>{T.taskNoMcp(shortAgentName(plan.main.label))}</p>
              <p>{T.taskNoMcpHow}</p>
              {import.meta.env.DEV && <p>{T.taskNoMcpDev}</p>}
            </div>
          )}
          {starting && (
            <div className="fr-working" role="status" data-testid="task-opening">
              <DotSpinner status="running" size={5} />
              <div>
                <p className="fr-working-line">{T.taskOpening(shortAgentName(plan.main.label))}</p>
                <p className="fr-hint fr-mono">{formatElapsed(Math.max(0, now - openedAt))}</p>
              </div>
            </div>
          )}
          <div className="fr-actions">
            <button type="button" className="ck-btn ck-btn--primary" disabled={starting} onClick={() => void start()}>
              {starting ? T.taskStarting : T.taskStart(shortAgentName(plan.main.label))}
            </button>
          </div>
        </>
      )}

      {pane && view.warm !== null && (
        <p className="fr-hint" data-testid="task-warm">{view.warm ? T.taskWarm : T.taskCold}</p>
      )}

      {pane && !done && !alone && (
        <div className="fr-working" role="status">
          <DotSpinner status={waiting ? 'waiting_input' : 'running'} size={5} />
          <div>
            <p className="fr-working-line">{waiting ? T.taskAsking(shortAgentName(plan.main.label)) : T.taskWorking(shortAgentName(plan.main.label))}</p>
            <p className="fr-hint fr-mono">{formatElapsed(Math.max(0, now - view.startedAt))}</p>
          </div>
        </div>
      )}

      {pane && plan.helper && (
        <div className="fr-helpers" data-testid="task-helpers">
          <h2 className="fr-cap">{T.taskHelpers}</h2>
          {helpers.length === 0 ? (
            <p className="fr-hint">{T.taskNoHelper}</p>
          ) : (
            <ul className="fr-agentlist">
              {helpers.map((h) => {
                const st = helperStatus(h.status, c.prompts[h.info.id] != null);
                return (
                  <li key={h.info.id} className="fr-agentrow" data-state={st}>
                    <DotSpinner status={st === 'done' ? 'exited' : st === 'failed' ? 'error' : st === 'needs-you' ? 'waiting_input' : 'running'} size={3} />
                    <span className="fr-agentname">{shortAgentName(c.names.get(h.info.id) ?? h.info.title ?? h.info.agent_type)}</span>
                    <span className="fr-agentstate">{HELPER_STATUS_LABEL[st]}</span>
                    <button type="button" className="ck-btn ck-btn--plain ck-btn--sm" onClick={() => onOpenPane(h.info.id)}>
                      {T.openPane}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {cards.map((q) => (
        <div className="fr-approval" key={q.id} data-testid="task-question">
          <QuestionCard
            q={q}
            paneName={q.pane_id ? c.names.get(q.pane_id) : undefined}
            now={c.now}
            onAnswer={(a) => void c.asked.answerQuestion(q.id, a)}
            onDismiss={() => void c.asked.dismissQuestion(q.id)}
            onOpenPane={q.pane_id && c.registry.panes.has(q.pane_id) ? () => onOpenPane(q.pane_id!) : undefined}
          />
        </div>
      ))}

      {asking.map(({ id, prompt }) => (
        <div className="fr-approval" key={id}>
          <ApprovalPrompt variant="card" prompt={prompt} autoFocus={false} onAnswer={(ch, gesture) => void c.answer(id, prompt.promptId, ch.id, ch.label, gesture)} />
          <p className="fr-tip">{T.approvalTip}</p>
        </div>
      ))}

      {pane && !done && !alone && (
        <div className="fr-actions">
          <button type="button" className="ck-btn ck-btn--plain ck-btn--sm" onClick={() => onOpenPane(pane)}>
            {T.openPane}
          </button>
        </div>
      )}

      {alone && (
        <div className="fr-result" data-testid="task-alone">
          <div className="fr-result-head">
            <DotSpinner status="error" size={3} />
            <h2 className="ck-section">{T.taskAlone}</h2>
          </div>
          <p className="fr-answer">{T.taskAloneBody}</p>
          <div className="fr-actions">
            <button type="button" className="ck-btn ck-btn--primary" onClick={again}>
              {T.taskAgain}
            </button>
            {pane && (
              <button type="button" className="ck-btn ck-btn--plain" onClick={() => onOpenPane(pane)}>
                {T.openPane}
              </button>
            )}
          </div>
        </div>
      )}

      {done && (
        <div className="fr-result" data-testid="task-done">
          <div className="fr-result-head">
            <DotSpinner status="exited" size={3} />
            <h2 className="ck-section">{T.taskDoneTitle}</h2>
          </div>
          <p className="fr-answer">{T.taskDoneBody}</p>
          {view.tookMs !== null && <p className="fr-tip" data-testid="task-time">{T.taskTime(Math.round(view.tookMs / 1000))}</p>}
          {pane && (
            <div className="fr-actions">
              <button type="button" className="ck-btn ck-btn--secondary" onClick={() => onOpenPane(pane)}>
                {T.openPane}
              </button>
            </div>
          )}
        </div>
      )}
      {pane && !done && view.sawRunning && mainStatus === undefined && <p className="fr-hint" role="alert">{T.taskPaneFailed}</p>}
    </section>
  );
}
