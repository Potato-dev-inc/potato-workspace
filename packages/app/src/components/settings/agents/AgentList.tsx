// Settings > Agents: one row per agent (mark, name, how it stands with its next step, what it can do). A click opens
// that agent's page. The words say the next step and the step is the row's button: "Not signed in · Sign in",
// "Not installed · Install", "Ready".
import { terminalOnly } from '../../../lib/agentCaps';
import { AgentLogo } from '../../common/AgentLogo';
import { Btn } from '../settings-ui';
import { openAddAgentWith } from './agentTarget';
import { CapChips } from './CapChips';
import { nextStep, standingWords, type AgentRow } from './useAgentRows';

export function AgentList({ rows, onOpen, onCheck }: { rows: AgentRow[]; onOpen: (agentId: string) => void; onCheck?: (agentId: string) => Promise<void> }) {
  if (rows.length === 0) {
    return (
      <div className="st-row" data-testid="agent-list-empty">
        <div className="st-label">
          <span>No agents yet</span>
          <small>Add one above.</small>
        </div>
      </div>
    );
  }
  const run = (row: AgentRow, kind: 'signin' | 'install' | 'check') => {
    if (kind === 'install') openAddAgentWith(row.label);
    else if (kind === 'signin') onOpen(row.id);
    else void onCheck?.(row.id).catch(() => undefined);
  };
  return (
    <>
      {rows.map((row) => {
        const cli = row.caps !== null && terminalOnly(row.caps);
        const step = nextStep(row);
        return (
          // The whole row opens the page; the name is the real button, so the keyboard and screen readers get it too.
          <div key={row.id} className="st-row ag-row" data-testid={`agent-row-${row.id}`} data-agent={row.id} data-installed={row.installed ? 'true' : 'false'} onClick={() => onOpen(row.id)}>
            <button type="button" className="ag-open" aria-label={`${row.label}, ${standingWords(row)}. Open its page`}>
              <span className="ag-mark">
                <AgentLogo id={row.id} name={row.label} size={20} decorative />
              </span>
              <span className="ag-main">
                <span className="ag-name">{row.label}</span>
                <span className="ag-standing" data-state={row.state}>
                  {standingWords(row)}
                  {cli ? ' · Terminal only' : ''}
                </span>
              </span>
            </button>
            {row.caps && !cli && (
              <span className="ag-row-chips">
                <CapChips caps={row.caps} name={row.label} compact />
              </span>
            )}
            {step && (
              <Btn
                small
                className="ag-step"
                aria-label={`${step.label} ${row.label}`}
                onClick={(e) => {
                  e.stopPropagation();
                  run(row, step.kind);
                }}
              >
                {step.label}
              </Btn>
            )}
            <span className="ag-go" aria-hidden="true">
              ›
            </span>
          </div>
        );
      })}
    </>
  );
}
