// A quiet text button that opens "Bring my chats". Used where people look for their old chats: the empty chat list,
// the New agent page and Settings. It only asks for the panel (lib/chatImport.ts); nothing is read until the person
// is inside it.
import { useT } from '../../i18n';
import { requestBringChats } from '../../lib/chatImport';

export function BringChatsLink({ label, className = 'bc-link' }: { label?: string; className?: string }) {
  const t = useT();
  return (
    <button type="button" className={className} data-testid="bring-chats-link" onClick={() => requestBringChats()}>
      {label ?? t('state.bringChats')}
    </button>
  );
}
