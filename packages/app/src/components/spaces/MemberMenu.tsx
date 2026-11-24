// Spaces: the actions on one person in the people column: Remove from space (owner), Block and Unblock (me only).
import { useRef, useState } from 'react';
import { Menu } from '../common/Floating';
import type { SpaceMember } from '../../lib/spaces';
import { ConfirmSheet } from './ConfirmSheet';
import { t } from '../../i18n';

export interface MemberMenuProps {
  member: SpaceMember;
  spaceName: string;
  canRemove: boolean;
  onRemove: () => void;
  onBlock: (on: boolean) => void;
}

export function MemberMenu({ member, spaceName, canRemove, onRemove, onBlock }: MemberMenuProps) {
  const [open, setOpen] = useState(false);
  const [sheet, setSheet] = useState<'remove' | 'block' | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  if (member.isMe) return null;
  return (
    <span className="ck-spaces-menu">
      <button ref={btn} type="button" className="ck-spaces-link" aria-label={`Actions for ${member.name}`} aria-haspopup="menu"
        aria-expanded={open} onClick={() => setOpen(!open)}>More</button>
      {open && (
        <Menu anchorRef={btn} align="end" className="ck-spaces-menu-list" label={`Actions for ${member.name}`} onClose={() => setOpen(false)}>
          {canRemove && (
            <button type="button" role="menuitem" onClick={() => { setOpen(false); setSheet('remove'); }}>{t('r21.sw.removeFromSpace')}</button>
          )}
          {member.blocked ? (
            <button type="button" role="menuitem" onClick={() => { setOpen(false); onBlock(false); }}>Unblock</button>
          ) : (
            <button type="button" role="menuitem" onClick={() => { setOpen(false); setSheet('block'); }}>Block</button>
          )}
        </Menu>
      )}
      {sheet === 'remove' && (
        <ConfirmSheet title={`Remove ${member.name} from ${spaceName}?`}
          body="They will stop getting new messages. Messages they already have stay on their computer."
          confirmLabel="Remove" onClose={() => setSheet(null)} onConfirm={() => { setSheet(null); onRemove(); }} />
      )}
      {sheet === 'block' && (
        <ConfirmSheet title={`Block ${member.name}?`}
          body={`You won't see their messages in ${spaceName}. They are not told. Fish won't answer them on your computer.`}
          confirmLabel="Block" onClose={() => setSheet(null)} onConfirm={() => { setSheet(null); onBlock(true); }} />
      )}
    </span>
  );
}
