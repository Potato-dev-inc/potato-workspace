import { ForceYesChip } from '../components/chat/ForceYesChip';
import { PinnedLine } from '../components/cockpit/newagent/PinnedLine';
import { AgentRulesPanel } from '../components/settings/blocks/AgentRulesPanel';
import type { AcpChatState } from '../lib/acpChat';
import type { AgentRulesApi, RulesOverview } from '../lib/agentRules';

const overview: RulesOverview = {
  forceYesAgents: ['agy'],
  pinGlobal: { model: null, mode: null, force_yes: null, notes: 'Run the tests before you say you are done.' },
  projects: [{ project: 'd:/work/shop', fences: ['secrets', 'config/prod.yml'], pin: { model: null, mode: null, force_yes: true, notes: null } }],
};
const api: AgentRulesApi = {
  overview: async () => overview,
  effective: async () => ({ model: null, mode: null, force_yes: false, force_yes_source: null, notes: null, fences: [] }),
  setForceYesAgent: async (_a, on) => on,
  fenceAdd: async () => [],
  fenceRemove: async () => [],
  pinSet: async (_p, pin) => pin,
  paneSetForceYes: async (_id, on) => on,
  paneForceYes: async () => false,
};
const chatState = (forceYes: boolean) => ({ forceYes, closed: false }) as unknown as AcpChatState;
const noChat = { setForceYes: async () => chatState(true) };

// The three places Force yes, Fences and Pins show up: the chip in a pane header (off with its warning open, and on), the
// line on the New agent page, and Settings > Agents > Rules for agents.
export function Preview() {
  return (
    <div className="cockpit" style={{ position: 'fixed', inset: 0, zIndex: 99999, background: 'var(--bg)', color: 'var(--label)', overflow: 'auto', padding: 24, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 20, alignContent: 'start' }}>
      <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start', minHeight: 240 }}>
        <ForceYesChip paneId="a" isAcp state={chatState(false)} agent="agy" cwd="D:/work/shop" chatApi={noChat} />
        <ForceYesChip paneId="b" isAcp state={chatState(true)} agent="agy" cwd="D:/work/shop" chatApi={noChat} />
      </div>
      <PinnedLine pins={{ model: 'gpt-5-mini', mode: 'plan', force_yes: true, force_yes_source: 'pin', notes: 'Run the tests first.', fences: ['secrets', 'config/prod.yml'] }} onChange={() => {}} />
      <div className="st-body" style={{ maxWidth: 640 }}>
        <AgentRulesPanel api={api} />
      </div>
    </div>
  );
}
