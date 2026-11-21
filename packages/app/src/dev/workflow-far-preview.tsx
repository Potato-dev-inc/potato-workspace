import { useMemo, useState } from 'react';
import { CrewChip } from '../components/chat/CrewChip';
import { WorkflowCard } from '../components/crews/WorkflowCard';
import { crewMembers } from '../lib/crew-chip';
import { HostProvider } from '../lib/host/context';
import { ALL_CAPS, type Host } from '../lib/host/host';
import { workflowLine, useWorkflowModel } from '../lib/workflow-model';
import { useWorkflowsEnabled, type LivePane } from '../lib/workflow-live';

// A workflow front's chat header on this PC and on another PC, side by side (P3.1). Each column is built the way the chat screen builds it:
// the crew chip from the pane list, the workflow card from `useWorkflowModel`. Only the HOST differs: the far column's crew and Labs switch
// come from a fake far PC (`workflows_list`, `crews_get`), through the same `useHost()` the screen uses. Example data only.
const CREW = {
  name: 'Research + Write',
  roles: [
    { name: 'Front', agent_type: 'claude', model: 'haiku', task: 'Route.', front: true },
    { name: 'Researcher', agent_type: 'claude', model: 'sonnet', task: 'Find facts.', parent: 'Front', when_to_use: 'research' },
    { name: 'Writer', agent_type: 'claude', model: 'sonnet', task: 'Write.', parent: 'Front', when_to_use: 'writing' },
  ],
};
const T = Date.now();
const mk = (id: string, status: string, title: string, parent?: string, task?: string): LivePane => ({
  status,
  info: { id, agent_type: 'claude', status, pid: 1, created_at: T - (parent ? 90_000 : 600_000), last_output_at: null, cwd: 'C:\work\shop', cols: 80, rows: 24, title, parent_pane_id: parent, started_as: parent ? 'minion' : undefined, origin: task ? { host: 'Claude', task } : undefined } as LivePane['info'],
});
const PANES = [mk('front', 'running', 'Router'), mk('h1', 'running', 'Researcher', 'front', 'find facts'), mk('h2', 'waiting_input', 'Writer', 'front', 'write it')];

const fake = (place: Host['place']): Host => ({
  place,
  live: true,
  caps: ALL_CAPS,
  invoke: (async (cmd: string) => (cmd === 'crews_get' ? CREW : cmd === 'workflows_list' ? [{ slug: 'wf' }] : null)) as Host['invoke'],
  listen: (async () => () => undefined) as Host['listen'],
});

function Header({ caption }: { caption: string }) {
  const on = useWorkflowsEnabled();
  const [now] = useState(() => Date.now());
  const names = (p: LivePane) => p.info.title ?? p.info.agent_type;
  const model = useWorkflowModel('front', PANES, on, names);
  const members = useMemo(() => crewMembers(PANES, 'front', names), []);
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ font: '600 12px var(--font-sans, system-ui)', color: 'var(--label-2, var(--label))', padding: '0 0 8px' }}>{caption}</div>
      <div data-testid={`far-col-${caption}`}>
        <CrewChip members={members} now={now} onOpen={() => undefined} onStop={() => undefined} onOpenLive={() => undefined} />
        {model ? <WorkflowCard model={model} onOpenHelper={() => undefined} /> : <div data-testid="no-workflow">{workflowLine(null, [])}</div>}
      </div>
    </div>
  );
}

const shell = { position: 'fixed', inset: 0, zIndex: 500, background: 'var(--bg)', color: 'var(--label)', overflow: 'auto' } as const;

export function WorkflowFarPreview() {
  const local = useMemo(() => fake({ kind: 'local' }), []);
  const far = useMemo(() => fake({ kind: 'pc', node: 'n1', name: 'Mac mini' }), []);
  return (
    <div className="cockpit" style={shell}>
      <div style={{ display: 'flex', gap: 24, width: 1100, margin: '0 auto', paddingTop: 16 }}>
        <HostProvider host={local}>
          <Header caption="This PC" />
        </HostProvider>
        <HostProvider host={far}>
          <Header caption="Mac mini" />
        </HostProvider>
      </div>
    </div>
  );
}
