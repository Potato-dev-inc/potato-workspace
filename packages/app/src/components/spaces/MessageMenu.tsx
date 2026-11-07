// Spaces: the actions on one message. Only Reply, React and Delete exist; nothing here runs, opens or approves
// anything that a message says (cowork M2).
import { useState } from 'react';
import { REACTION_LABEL, type ReactionCode, type SpaceMessage } from '../../lib/spaces';
import { ConfirmSheet } from './ConfirmSheet';
import { REACTION_PICTURE } from './MessageRow';

export interface MessageMenuProps {
  message: SpaceMessage;
  canDelete: boolean;
  onReply: () => void;
  onReact: (code: ReactionCode) => void;
  onDelete: () => void;
}

export function MessageMenu({ message, canDelete, onReply, onReact, onDelete }: MessageMenuProps) {
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [confirm, setConfirm] = useState(false);
  if (message.deleted) return null;
  const close = () => { setOpen(false); setPicking(false); };
  return (
    <span className="ck-spaces-menu">
      <button type="button" className="ck-spaces-link" aria-label="Message actions" aria-haspopup="menu" aria-expanded={open}
        onClick={() => { setOpen(!open); setPicking(false); }}>More</button>
      {open && (
        <span role="menu" className="ck-spaces-menu-list">
          <button type="button" role="menuitem" onClick={() => { close(); onReply(); }}>Reply</button>
          <button type="button" role="menuitem" aria-expanded={picking} onClick={() => setPicking(!picking)}>React</button>
          {picking && (
            <span role="group" aria-label="Pick a reaction" className="ck-spaces-picker">
              {(Object.keys(REACTION_LABEL) as ReactionCode[]).map((c) => (
                <button key={c} type="button" aria-label={REACTION_LABEL[c]} title={REACTION_LABEL[c]}
                  onClick={() => { close(); onReact(c); }}>{REACTION_PICTURE[c]}</button>
              ))}
            </span>
          )}
          {canDelete && (
            <button type="button" role="menuitem" onClick={() => { close(); setConfirm(true); }}>Delete</button>
          )}
        </span>
      )}
      {confirm && (
        <ConfirmSheet title="Delete this message?"
          body="It disappears for everyone in this space. People who already saw it may still have a copy."
          confirmLabel="Delete" onClose={() => setConfirm(false)} onConfirm={() => { setConfirm(false); onDelete(); }} />
      )}
    </span>
  );
}
