// What an agent can do, as chips. The look of a chip is a pure function of what the app has proof of:
//   yes      filled, with a tick
//   no       solid outline, dim, with a cross
//   unknown  dashed outline, no mark. Listed after the known ones under "Fills in after your first chat:".
// Nothing here upgrades a chip. No colour carries meaning.
import { chipViews, sourceText, terminalOnly, type AgentCaps, type ChipView } from '../../../lib/agentCaps';

export const UNKNOWN_CAPTION = 'Fills in after your first chat:';
/** The list row shows this many known chips; the page shows all of them. */
export const LIST_CHIPS = 3;

function KnownChip({ chip, name }: { chip: ChipView; name: string }) {
  const tip = sourceText(chip.cap?.source ?? 'unknown', name);
  const yes = chip.value === 'yes';
  return (
    <li className={`ag-chip is-${chip.value}`} data-chip={chip.key} data-value={chip.value} tabIndex={0} title={tip} aria-label={`${chip.label}: ${yes ? 'yes' : 'no'}. ${tip}`}>
      <span className="ag-chip-mark" data-mark={chip.value} aria-hidden="true">
        {yes ? '✓' : '✕'}
      </span>
      <span>{chip.label}</span>
    </li>
  );
}

/**
 * The chips of one agent. Known chips first (yes, then no); the ones not seen yet follow a quiet caption, dashed and
 * without a mark. `compact` (the list) is one line of plain grey words instead of pills. An agent that cannot chat shows none: it is
 * a terminal agent, and the page says so.
 */
export function CapChips({ caps, name, compact = false }: { caps: AgentCaps | null; name: string; compact?: boolean }) {
  if (!caps || terminalOnly(caps)) return null;
  const { known, unknown } = chipViews(caps);
  if (compact) {
    // The list shows plain grey words ("Chat · Remembers · Asks first · +2"), only for what is a yes. The pills are for the page.
    const yes = known.filter((c) => c.value === 'yes');
    if (yes.length === 0) return null;
    const shown = yes.slice(0, LIST_CHIPS);
    const more = yes.length - shown.length;
    return (
      <span className="ag-chips-text" aria-label={`What ${name} can do`}>
        {shown.map((c) => c.label).join(' · ')}
        {more > 0 ? ` · +${more}` : ''}
      </span>
    );
  }
  return (
    <div className="ag-chipset">
      {known.length > 0 && (
        <ul className="ag-chips" aria-label={`What ${name} can do`}>
          {known.map((chip) => (
            <KnownChip key={chip.key} chip={chip} name={name} />
          ))}
        </ul>
      )}
      {unknown.length > 0 && (
        <>
          <p className="ag-caption">{UNKNOWN_CAPTION}</p>
          <ul className="ag-chips is-unknown" aria-label={`Not seen yet for ${name}`}>
            {unknown.map((chip) => (
              <li key={chip.key} className="ag-chip is-unknown" data-chip={chip.key} data-value="unknown" tabIndex={0} title={sourceText('unknown', name)} aria-label={`${chip.label}: not seen yet`}>
                <span>{chip.label}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
