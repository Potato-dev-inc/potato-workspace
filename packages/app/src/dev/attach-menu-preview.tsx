import { useState, type FC } from 'react';
import { AttachMenu } from '../components/chat/AttachMenu';
import { AttachmentChips } from '../components/chat/AttachmentChips';
import type { ChatAttachment } from '../lib/attachFiles';

// The "+" menu of the message box and a folder chip beside a file chip, drawn with the real components and CSS.
const CHIPS: ChatAttachment[] = [
  { name: 'workspace', path: 'C:\Users\dev\work\workspace', kind: 'folder', size: 1284, mime: 'inode/directory' },
  { name: 'ci-run.log', path: 'C:\Users\dev\work\ci-run.log', kind: 'file', size: 48_213, mime: 'text/plain' },
];

export const AttachPreview: FC<{ withMenu?: boolean }> = () => {
  const [last, setLast] = useState('');
  return (
    <div className="cockpit" style={{ position: 'fixed', inset: 0, zIndex: 99999, display: 'block', background: 'var(--bg)', color: 'var(--label)', padding: 24 }}>
      <div style={{ maxWidth: 520, margin: '0 auto', minHeight: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: 10 }}>
        <div style={{ border: '1px solid var(--sep)', borderRadius: 14, background: 'var(--bg-raised)', padding: 10 }}>
          <AttachmentChips attachments={CHIPS} onRemove={() => undefined} />
          <div style={{ padding: '8px 4px', color: 'var(--label-2)', fontSize: 14 }}>Look through the workspace folder and summarise what it does. {last}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <AttachMenu onPickFiles={() => setLast('')} onPickFolder={() => setLast('')} onPickImage={() => setLast('')} />
          </div>
        </div>
      </div>
    </div>
  );
};
