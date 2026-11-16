// The chat-look switches, in the chat's own View menu: "Jump marks beside the chat" and "Show if build and tests
// passed". They used to sit in Settings > Agents > Chat; the person changes them while looking at a chat. The same
// switches on the same stores, so Settings and the menu can never disagree.
import { useT } from '../../i18n';
import { useMessageRail } from '../../lib/messageRail';
import { useDoneCardSwitch } from '../../lib/done-card';

export function ChatLookSwitches() {
  const t = useT();
  const [rail, setRail] = useMessageRail();
  const [done, setDone] = useDoneCardSwitch();
  return (
    <div className="ck-chat-look" role="group" aria-label={t('chatLook.group')}>
      <label className="ck-chat-look-row">
        <input type="checkbox" checked={rail} onChange={(event) => setRail(event.target.checked)} />
        <span>{t('settings.row.message-rail.label')}</span>
      </label>
      <label className="ck-chat-look-row">
        <input type="checkbox" checked={done} onChange={(event) => setDone(event.target.checked)} />
        <span>{t('settings.row.done-card.label')}</span>
      </label>
    </div>
  );
}
