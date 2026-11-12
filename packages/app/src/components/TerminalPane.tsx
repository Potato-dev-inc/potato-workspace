import type { HTMLAttributes } from 'react';
import { useRef, useState } from 'react';
import type { AgentType } from '@potato-workspace/shared';
import {
  agentLabel,
  launchMenuEntries,
  openableLaunchEntries,
  useAgentRegistry,
  type AgentRegistryListing,
  type LaunchEntry,
} from '../lib/agentRegistry';
import { useTerminalSession } from '../hooks/useTerminalSession';
import type { PaneData } from '../hooks/usePaneRegistry';
import { SessionChatPanel } from './chat/SessionChatPanel';

interface Props {
  pane: PaneData;
  subscribePaneData: (paneId: string, cb: (data: Uint8Array) => void) => () => void;
  onClose: (paneId: string) => void;
  onPopOut: (paneId: string, size?: { width: number; height: number }) => void;
  onSwitchAgent: (paneId: string, agentType: AgentType) => Promise<void>;
  dragHandleProps?: HTMLAttributes<HTMLButtonElement>;
  syncPTYResize?: boolean;
  /** Bump to force a re-fit at the cell's current size (sends no resize when the grid is unchanged). */
  reflowKey?: number | string;
  /** Bump to also redraw an alternate-screen TUI (two PTY resizes), e.g. when the pane re-enters the grid. */
  redrawKey?: number | string;
}

const STATUS_COLOR: Record<string, string> = {
  running: 'bg-pm-ok',
  waiting_input: 'bg-pm-warn',
  idle: 'bg-pm-muted',
  error: 'bg-pm-err',
};

/** Terminal (the default) or the read-only chat over it. The terminal stays mounted either way. */
type PaneView = 'terminal' | 'chat';

/** A plain shell has no agent conversation (no session file, nothing to read off the screen), so it gets no Chat toggle. */
function isPlainShell(listing: AgentRegistryListing, agent: AgentType): boolean {
  return listing.agents.find((a) => a.id === agent)?.kind === 'shell';
}

function switchPresetsFor(listing: AgentRegistryListing, agent: AgentType): LaunchEntry[] {
  const launchPresets = openableLaunchEntries(launchMenuEntries(listing));
  if (launchPresets.some((preset) => preset.type === agent)) {
    return launchPresets;
  }
  return [{ type: agent, label: agentLabel(listing, agent), icon: null }, ...launchPresets];
}

export function TerminalPane({
  pane,
  subscribePaneData,
  onClose,
  onPopOut,
  onSwitchAgent,
  dragHandleProps,
  syncPTYResize = true,
  reflowKey,
  redrawKey,
}: Props) {
  const [switching, setSwitching] = useState(false);
  const [view, setView] = useState<PaneView>('terminal');
  const rootRef = useRef<HTMLDivElement>(null);
  const { containerRef, nudgeReflow } = useTerminalSession({
    paneId: pane.info.id,
    sessionKey: pane.info.created_at,
    subscribePaneData,
    syncPTYResize,
    reflowKey,
    redrawKey,
    reprintsOnResize: pane.info.reprints_on_resize,
  });

  const agent = pane.info.agent_type as AgentType;
  const listing = useAgentRegistry();
  const presets = switchPresetsFor(listing, agent);
  const preset = presets.find((p) => p.type === agent);
  const chatAllowed = !isPlainShell(listing, agent);
  const showChat = chatAllowed && view === 'chat';

  const handleAgentChange = async (next: AgentType) => {
    if (next === agent || switching) return;
    setSwitching(true);
    try {
      await onSwitchAgent(pane.info.id, next);
    } finally {
      setSwitching(false);
    }
  };

  return (
    <div ref={rootRef} className="flex flex-col h-full rounded border border-pm-border bg-pm-bg overflow-hidden relative">
      {switching && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-pm-bg/80 text-xs text-pm-muted">
          Switching agent…
        </div>
      )}
      <div className="flex items-center gap-2 px-2 py-1 border-b border-pm-border bg-pm-panel text-xs text-pm-text">
        <button
          type="button"
          className="cursor-grab active:cursor-grabbing px-1 text-pm-muted hover:text-pm-text"
          title="Drag to reorder pane"
          aria-label="Drag to reorder pane"
          {...dragHandleProps}
        >
          ::
        </button>
        <span
          className={`inline-block w-2 h-2 rounded-full ${STATUS_COLOR[pane.status] ?? 'bg-pm-muted'}`}
          title={pane.status}
        />
        <select
          className="bg-pm-bg border border-pm-border rounded px-1 py-0.5 text-xs disabled:opacity-50"
          value={agent}
          disabled={switching}
          onChange={(e) => void handleAgentChange(e.target.value as AgentType)}
        >
          {presets.map((p) => (
            <option key={p.type} value={p.type}>
              {p.label}
            </option>
          ))}
        </select>
        {chatAllowed && (
          <div role="group" aria-label="Pane view" className="flex overflow-hidden rounded border border-pm-border">
            {(['terminal', 'chat'] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                className={`px-1.5 py-0.5 ${view === v ? 'bg-pm-border/60 text-pm-text' : 'text-pm-muted hover:text-pm-text'}`}
                onClick={() => setView(v)}
              >
                {v === 'terminal' ? 'Terminal' : 'Chat'}
              </button>
            ))}
          </div>
        )}
        <span className="text-pm-muted truncate" title={pane.info.cwd}>
          {preset?.label ?? pane.info.agent_type} · pid {pane.info.pid}
        </span>
        <div className="flex-1" />
        <button
          className="px-1.5 py-0.5 rounded text-pm-muted hover:text-pm-text hover:bg-pm-border/40"
          title="Pop out pane"
          onClick={() => {
            const rect =
              containerRef.current?.getBoundingClientRect() ??
              rootRef.current?.getBoundingClientRect();
            onPopOut(
              pane.info.id,
              rect ? { width: rect.width, height: rect.height } : undefined,
            );
          }}
        >
          ↗
        </button>
        <button
          type="button"
          className="px-1.5 py-0.5 rounded text-pm-muted hover:text-pm-text hover:bg-pm-border/40"
          title="Nudge layout reflow"
          aria-label="Nudge layout reflow"
          onClick={nudgeReflow}
        >
          ↻
        </button>
        <button
          className="px-1.5 py-0.5 rounded text-pm-muted hover:text-pm-err hover:bg-pm-err/10"
          title="Kill pane"
          onClick={() => onClose(pane.info.id)}
        >
          ✕
        </button>
      </div>
      <div className="relative flex-1 min-h-0">
        {/* Hidden, never unmounted: unmounting would break the PTY grid. `invisible` keeps the layout size. */}
        <div ref={containerRef} className={`h-full overflow-hidden terminal-host${showChat ? ' invisible' : ''}`} />
        {showChat && (
          <div className="absolute inset-0 z-10">
            <SessionChatPanel paneId={pane.info.id} />
          </div>
        )}
      </div>
    </div>
  );
}
