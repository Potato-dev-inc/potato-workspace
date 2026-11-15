import { AcpResultStrip } from '../components/cockpit/AcpResultStrip';

// The result card under a chat, with "Then…": the one chain step the person adds from the chat.
export function Preview() {
  return (
    <div className="cockpit" style={{ position: 'fixed', inset: 0, zIndex: 99999, background: 'var(--bg)', color: 'var(--label)', overflow: 'auto', padding: 24 }}>
      <AcpResultStrip result={{ files: '3 files +14 −3', paths: [], summary: 'Fixed the cart total rounding.', checks: [], questions: [] }} paneId="pane-1" cwd="C:/work/shop" />
    </div>
  );
}
