// One companion in the sidebar, above Inbox: the Potato face (its pose follows the mood), its name and one live line
// ("Watching 3 agents", "Codex needs you", "Sleepy"). With no companion yet, one quiet line asks the person to make one.
import type { CompanionView } from '../../../lib/companion';
import type { Mood } from '../../../lib/companionMood';
import { useT } from '../../../i18n';
import { PotatoFace } from '../PotatoFace';
import '../../../styles/cockpit-companion.css';

export function CompanionRow({ companion, mood, active, onOpen }: { companion: CompanionView; mood: Mood; active: boolean; onOpen: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      className={`ck-row ck-companion-row${active ? ' is-active' : ''}${mood.urgent ? ' is-needs' : ''}`}
      onClick={onOpen}
      aria-current={active ? 'true' : undefined}
      data-mood={mood.face}
    >
      <span className="ck-row-glyph ck-companion-face">
        <PotatoFace state={mood.face} size={28} />
      </span>
      <span className="ck-row-main">
        <span className="ck-row-title">{companion.name}</span>
        <span className="ck-companion-line" aria-live="polite">
          {t(mood.key, mood.vars)}
        </span>
      </span>
    </button>
  );
}

/** One quiet line at the bottom of the sidebar while the person has no companion. */
export function MakeCompanionRow({ onMake }: { onMake: () => void }) {
  const t = useT();
  return (
    <button type="button" className="ck-companion-make" onClick={onMake}>
      {t('companion.makeQuiet')}
    </button>
  );
}
