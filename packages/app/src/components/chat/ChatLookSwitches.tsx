// The chat-look switches, in the chat's own View menu: "Jump marks beside the chat", "Show if build and tests
// passed" and "Show 'more than usual' notes". The person changes them while looking at a chat. The same switches on
// the same stores, so Settings and the menu can never disagree. Drawn with the app's own switch (`.ck-switch`).
import { useT } from '../../i18n';
import { useMessageRail } from '../../lib/messageRail';
import { useDoneCardSwitch } from '../../lib/done-card';
import { useUsualNotesOn, setUsualNotesOn } from '../../lib/usual-notes';

/** One label and its switch. The whole row is the press target; the switch is the control the screen reader reads. */
export function LookSwitch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (next: boolean) => void }) {
  return (
    <div className="ck-chat-look-row">
      <span className="ck-chat-look-label">{label}</span>
      <button type="button" role="switch" aria-checked={checked} aria-label={label} className="ck-switch" onClick={() => onChange(!checked)}>
        <span className="ck-switch-knob" aria-hidden="true" />
      </button>
    </div>
  );
}

export function ChatLookSwitches() {
  const t = useT();
  const [rail, setRail] = useMessageRail();
  const [done, setDone] = useDoneCardSwitch();
  const usual = useUsualNotesOn();
  return (
    <div className="ck-chat-look" role="group" aria-label={t('chatLook.group')}>
      <LookSwitch label={t('settings.row.message-rail.label')} checked={rail} onChange={setRail} />
      <LookSwitch label={t('settings.row.done-card.label')} checked={done} onChange={setDone} />
      <LookSwitch label={t('settings.row.usual-notes.label')} checked={usual} onChange={setUsualNotesOn} />
    </div>
  );
}
