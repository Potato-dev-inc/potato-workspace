import { useState, type FC } from 'react';
import { MiniBar } from '../components/minibar/MiniBar';
import type { PaneInfo } from '../lib/tauri-types';

// The Individual-mode mini bar with many agents, drawn with the real component and CSS at the bar's fixed width.
const AGENTS = ['claude', 'opencode_native', 'codex', 'claude', 'cursor', 'opencode_native', 'claude', 'codex', 'claude', 'cursor'];
const PANES = AGENTS.map(
  (agent_type, i) => ({ id: `p${i}`, agent_type, cwd: 'C:\\work\\pm-workspace', status: i === 7 ? 'waiting_input' : i % 4 === 0 ? 'running' : 'idle' }) as unknown as PaneInfo,
);

export const MiniBarPreview: FC = () => {
  const [panes, setPanes] = useState(PANES);
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 99999, background: '#6b6b6b', padding: 8 }}>
      <div style={{ width: 760, height: 44 }}>
        <style>{".mb{height:44px}"}</style>
        <MiniBar
          panes={panes}
          toast={false}
          onFocusPane={() => undefined}
          onClosePane={(id) => setPanes((cur) => cur.filter((p) => p.id !== id))}
          onNew={() => undefined}
          onBack={() => undefined}
          onUndo={() => undefined}
          labelOf={(id) => ({ claude: 'Claude', codex: 'Codex CLI', cursor: 'Cursor', opencode_native: 'OpenCode' })[id] ?? id}
        />
      </div>
    </div>
  );
};
