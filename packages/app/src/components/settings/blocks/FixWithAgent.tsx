// One button that gives a job to the person's own agent: "Let an agent do it". The app never runs the steps itself
// (some of them change Windows); the agent gets the task in a chat, explains each thing in plain words and asks first.
// The same hand-off the first-run set-up and the worker update use (`requestAddAgentAction`, `pickHandoffAgent`).
// Nothing here shows a command: the task text goes to the agent, not onto the screen.
import { useEffect, useRef, useState } from 'react';
import { useT } from '../../../i18n';
import { requestAddAgentAction } from '../../../lib/addAgentActions';
import { loadAgentView, pickHandoffAgent } from '../../../lib/workerUpdate';
import type { AcpLaneView } from '../../../lib/acpChat';
import { Btn } from '../settings-ui';

type Handoff = { kind: 'none' } | { kind: 'busy' } | { kind: 'sent'; agent: string } | { kind: 'copied' };

export interface FixWithAgentDeps {
  loadAgents: () => Promise<AcpLaneView | null>;
  handOff: typeof requestAddAgentAction;
}
const DEFAULT_DEPS: FixWithAgentDeps = { loadAgents: loadAgentView, handOff: requestAddAgentAction };

/** What the agent is asked, in the person's voice: plain words, one goal, what is known. */
export function fixTask(goal: string, facts: string[]): string {
  return ["I'm not a developer. Please do this for me, explain each thing you do in plain words, and ask before you change anything on this PC.", '', `Goal: ${goal}`, ...facts].join('\n');
}

export function FixWithAgent({ label, task, testId = 'fix-with-agent', deps = DEFAULT_DEPS, small = true }: { label: string; task: string; testId?: string; deps?: FixWithAgentDeps; small?: boolean }) {
  const t = useT();
  const [state, setState] = useState<Handoff>({ kind: 'none' });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const go = async () => {
    setState({ kind: 'busy' });
    const agent = pickHandoffAgent(await deps.loadAgents().catch(() => null));
    if (!alive.current) return;
    if (!agent) {
      void navigator.clipboard?.writeText(task).catch(() => undefined);
      setState({ kind: 'copied' });
      return;
    }
    try {
      deps.handOff('chat', agent.id, task);
      setState({ kind: 'sent', agent: agent.label });
    } catch {
      void navigator.clipboard?.writeText(task).catch(() => undefined);
      setState({ kind: 'copied' });
    }
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-2" data-testid={testId}>
      <Btn small={small} disabled={state.kind === 'busy'} onClick={() => void go()}>
        {state.kind === 'busy' ? t('fixAgent.busy') : label}
      </Btn>
      {state.kind === 'sent' && (
        <span role="status" className="text-xs text-pm-muted">
          {t('fixAgent.sent', { agent: state.agent })}
        </span>
      )}
      {state.kind === 'copied' && (
        <span role="status" className="text-xs text-pm-muted">
          {t('fixAgent.noAgent')}
        </span>
      )}
    </span>
  );
}
