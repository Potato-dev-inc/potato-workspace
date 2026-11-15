import type { FC } from 'react';
import { ToolsOutOfDateBanner } from '../components/chat/ToolsOutOfDateBanner';
import { ToolsDriftList } from '../components/settings/sections/bridge/ToolsDrift';

// The "Tools are out of date" row above a chat and the same agent in Settings > Bridge, drawn with the real components.
export const ToolsStalePreview: FC = () => (
  <div className="cockpit" style={{ position: 'fixed', inset: 0, zIndex: 99999, display: 'block', background: 'var(--bg)', color: 'var(--label)', padding: 24 }}>
    <div style={{ maxWidth: 620, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div style={{ border: '1px solid var(--sep)', borderRadius: 14, background: 'var(--bg-raised)', overflow: 'hidden' }}>
        <div style={{ padding: '10px 12px', fontSize: 13, color: 'var(--label-2)', borderBottom: '1px solid var(--sep)' }}>Claude · my-project</div>
        <ToolsOutOfDateBanner paneId="pane-demo" />
        <div style={{ padding: '14px 12px', fontSize: 14, color: 'var(--label-2)' }}>I tried show_artifact but the tool was not found.</div>
      </div>
      <div className="st-group" style={{ padding: 12 }}>
        <div style={{ fontSize: 13, marginBottom: 6 }}>Connection check</div>
        <ToolsDriftList />
      </div>
    </div>
  </div>
);
