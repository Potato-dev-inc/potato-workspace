import { ChatCopyBar } from '../components/cockpit/ChatCopyBar';

// The strip a chat shows when it works on a copy: a Git copy with changes, a plain trial copy, and a copy with no changes yet.
export function Preview() {
  return (
    <div className="cockpit" style={{ position: 'fixed', inset: 0, zIndex: 99999, background: 'var(--bg)', color: 'var(--label)', overflow: 'auto', padding: 24, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 16, alignContent: 'start' }}>
      <ChatCopyBar kind="git" summary={{ kind: 'git', files: 3, additions: 42, deletions: 7 }} busy={false} onKeep={() => {}} onThrowAway={() => {}} />
      <ChatCopyBar kind="plain" summary={{ kind: 'plain', files: 1, additions: null, deletions: null }} busy={false} onKeep={() => {}} onThrowAway={() => {}} />
      <ChatCopyBar kind="git" summary={{ kind: 'git', files: 0, additions: 0, deletions: 0 }} busy={false} onKeep={() => {}} onThrowAway={() => {}} />
    </div>
  );
}
