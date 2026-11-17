import { CrewChip } from '../components/chat/CrewChip';
import type { CrewMember } from '../lib/crew-chip';

// The crew chip at the top of a chat (components/chat/CrewChip.tsx): 1, 3 and 12 agents started. Example data only.
const m = (id: string, kind: CrewMember['kind'], title: string, state: CrewMember['state'], agentType: string, minAgo: number): CrewMember => ({ id, kind, title, agentType, state, startedAt: Date.now() - minAgo * 60_000 });

export const CREW_SETS: Record<'one' | 'three' | 'twelve', CrewMember[]> = {
  one: [m('s1', 'spin_off', 'OpenCode 2', 'working', 'opencode', 4)],
  three: [m('s1', 'spin_off', 'Fix the login test', 'working', 'claude', 6), m('s2', 'spin_off', 'Try the other design', 'done', 'codex', 22), m('m1', 'minion', 'Review the diff', 'working', 'gemini', 2)],
  twelve: [
    m('n1', 'spin_off', 'Pick a database', 'needs-you', 'claude', 9),
    m('n2', 'minion', 'Check the install', 'needs-you', 'codex', 5),
    m('f1', 'minion', 'Run the slow tests', 'failed', 'codex', 14),
    m('w1', 'spin_off', 'Write the docs', 'working', 'claude', 12),
    m('w2', 'minion', 'Find old code', 'working', 'gemini', 3),
    m('w3', 'minion', 'Read the logs', 'working', 'opencode', 1),
    ...Array.from({ length: 6 }, (_, i) => m(`d${i}`, i % 2 ? 'minion' : 'spin_off', ['Rename files', 'Update the guide', 'Check the links', 'Tidy imports', 'Look up the API', 'Draft the notes'][i]!, 'done', ['claude', 'codex', 'gemini'][i % 3]!, 30 + i)),
  ],
};

const shell = { position: 'fixed', inset: 0, zIndex: 500, background: 'var(--bg)', color: 'var(--label)', overflow: 'auto' } as const;

export function CrewChipPreview({ set }: { set: keyof typeof CREW_SETS }) {
  return (
    <div className="cockpit" style={shell}>
      <div style={{ width: 560, margin: '0 auto', paddingTop: 12 }}>
        <CrewChip defaultOpen members={CREW_SETS[set]} now={Date.now()} onOpen={() => undefined} onStop={() => undefined} />
      </div>
    </div>
  );
}
