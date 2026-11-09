import type { PaneInfo } from '../../lib/tauri-types';
import '../../styles/individual-mode.css';

export interface MiniBarProps {
  panes: PaneInfo[];
  /** The Undo toast is up. */
  toast: boolean;
  onFocusPane: (id: string) => void;
  onNew: () => void;
  onBack: () => void;
  onUndo: () => void;
}

/** Last folder name of a path, either slash style. */
export function projectName(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

function agentName(id: string): string {
  return id ? id.charAt(0).toUpperCase() + id.slice(1).replace(/_/g, ' ') : 'Agent';
}

/** The strip that stays on screen in Individual mode: a chip per agent, New, Back, and the 8 s Undo. */
export function MiniBar({ panes, toast, onFocusPane, onNew, onBack, onUndo }: MiniBarProps) {
  return (
    <div className="mb" role="toolbar" aria-label="Individual mode">
      {toast ? (
        <div className="mb-toast" role="status">
          <span>Each agent now has its own window.</span>
          <button type="button" className="mb-link" onClick={onUndo}>
            Undo
          </button>
        </div>
      ) : panes.length === 0 ? (
        <>
          <span className="mb-empty">No agents yet</span>
          <button type="button" className="mb-btn" onClick={onNew}>
            Start one
          </button>
        </>
      ) : (
        <>
          <div className="mb-chips">
            {panes.map((p) => (
              <button
                key={p.id}
                type="button"
                className="mb-chip"
                title={`${agentName(p.agent_type)}: ${p.status.replace('_', ' ')}`}
                onClick={() => onFocusPane(p.id)}
              >
                <span className={`mb-dot mb-dot--${p.status}`} aria-hidden="true" />
                <span className="mb-chip-name">{agentName(p.agent_type)}</span>
                {projectName(p.cwd) && <span className="mb-chip-proj">{projectName(p.cwd)}</span>}
              </button>
            ))}
          </div>
          <button type="button" className="mb-btn" onClick={onNew}>
            + New
          </button>
        </>
      )}
      <button type="button" className="mb-btn" onClick={onBack}>
        Back to Orchestration
      </button>
    </div>
  );
}
