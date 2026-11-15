// One companion in the sidebar, above Inbox: the Potato face (its pose follows the mood), its name and one live line
// ("Watching 3 agents", "Codex needs you", "Sleepy"). With no companion yet, one quiet line asks the person to make one.
import type { CompanionView } from '../../../lib/companion';
import type { Mood } from '../../../lib/companionMood';
import { useT } from '../../../i18n';
import { dragSourceProps } from '../../dnd/dragSourceProps';
import { PotatoFace } from '../PotatoFace';
import '../../../styles/cockpit-companion.css';

export function CompanionRow({
  companion,
  mood,
  active,
  onOpen,
  showDefault = false,
}: {
  companion: CompanionView;
  mood: Mood;
  active: boolean;
  onOpen: () => void;
  /** Mark the default companion (only worth showing when there is more than one). */
  showDefault?: boolean;
}) {
  const t = useT();
  const isDefault = showDefault && companion.isDefault === true;
  return (
    <button
      type="button"
      className={`ck-row ck-companion-row${active ? ' is-active' : ''}${mood.urgent ? ' is-needs' : ''}`}
      onClick={onOpen}
      aria-current={active ? 'true' : undefined}
      data-mood={mood.face}
      data-accent={companion.accent ?? undefined}
      data-default={isDefault ? 'true' : undefined}
    >
      <span className="ck-row-glyph ck-companion-face" data-potato-drag="" {...dragSourceProps({ kind: 'potato', id: companion.id, label: companion.name })}>
        <PotatoFace state={mood.face} size={28} />
      </span>
      <span className="ck-row-main">
        <span className="ck-row-title">{companion.name}</span>
        <span className="ck-companion-line" aria-live="polite">
          {t(mood.key, mood.vars)}
        </span>
      </span>
      {isDefault && <span className="ck-companion-default" role="img" aria-label={t('companions.default')} title={t('companions.defaultTitle', { name: companion.name })} />}
    </button>
  );
}

/** A small "+ New companion" row under the companion rows (the sidebar hides it at the limit). */
export function NewCompanionRow({ onNew }: { onNew: () => void }) {
  const t = useT();
  return (
    <button type="button" className="ck-companion-new" onClick={onNew}>
      <span aria-hidden="true">+</span> {t('companions.new')}
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
