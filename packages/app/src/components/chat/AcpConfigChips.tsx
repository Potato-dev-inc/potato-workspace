// The agent's own settings (model, mode, effort) on the footer line of the message box of a chat session. One control per
// setting the agent offers (a pop-up menu, or a compact Low/Medium/High switch for the effort-like setting when it has
// four choices or fewer); nothing is drawn when it offers none. Settings change between turns, so the controls are
// switched off while the agent works (and when the conversation is open in a terminal).
import { useEffect, useRef, useState } from 'react';
import { Popover } from '../common/Floating';
import { useHost } from '../../lib/host/context';
import { chipsDisabled, configChips, errorSentence, tauriAcpChatApi, type AcpChatApi, type AcpChatState } from '../../lib/acpChat';
import { ChipMenu, ChipSegmented } from './ChipMenu';
import { localizeChip } from './chipWords';
import { isFullAccessMode, isPermissionChip, permissionFirst } from './permissionChip';
import { useT } from '../../i18n';
import '../../styles/cockpit-acp.css';

/** An effort-like setting with this many choices or fewer is drawn as a segmented switch. */
const SEGMENTED_MAX = 4;

export function AcpConfigChips({ paneId, state, api = tauriAcpChatApi }: { paneId: string; state: AcpChatState | null; api?: Pick<AcpChatApi, 'setConfig'> }) {
  // A pick shows at once; the backend's state replaces it when it arrives, and a refusal takes it back.
  const t = useT();
  // A place that does not let this person change settings draws the same chips switched off, with its one reason.
  const denied = useHost().denied?.('change') ?? null;
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  // A narrow column folds the chips into one settings button (CSS decides which shows); its list holds every setting.
  const [more, setMore] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const moreBtn = useRef<HTMLButtonElement>(null);
  // The list is drawn through the shared floating layer (in the top layer, placed in window pixels), so no column, rail or native page clips it.
  useEffect(() => {
    setPicked({});
    setError(null);
  }, [state?.configOptions, paneId]);

  const original = configChips(state);
  const chips = original.map(localizeChip);
  if (chips.length === 0) return null;
  const off = chipsDisabled(state) || denied !== null;
  const change = (id: string, value: string) => {
    setError(null);
    setPicked((cur) => ({ ...cur, [id]: value }));
    api.setConfig(paneId, id, value).catch((e: unknown) => {
      setPicked((cur) => {
        const { [id]: _gone, ...rest } = cur;
        return rest;
      });
      setError(errorSentence(e));
    });
  };
  return (
    <div className="ck-acp-chips" data-testid="acp-chips" ref={root}>
      <button type="button" ref={moreBtn} className="ck-pill ck-acp-more" data-testid="acp-chips-more" aria-label={t('pane.chipSettings')} title={t('pane.chipSettings')} aria-haspopup="dialog" aria-expanded={more} onClick={() => setMore((o) => !o)}>
        <span aria-hidden="true">⋯</span>
      </button>
      {more && (
        <Popover anchorRef={moreBtn} onClose={() => setMore(false)} align="start" prefer="up" className="ck-acp-more-pop" label={t('pane.chipSettings')} testId="acp-chips-popover">
          {permissionFirst(chips).map((chip) => {
            const shown = picked[chip.id] ?? chip.value;
            const kind = chip.category === 'mode' ? t('pane.chipPermissions') : chip.category === 'model' ? t('pane.chipModel') : chip.category === 'thought_level' ? t('pane.chipEffort') : chip.label;
            return (
              <div key={chip.id} className="ck-acp-more-group" role="radiogroup" aria-label={kind}>
                <p className="ck-acp-more-title">{kind}</p>
                {chip.choices.map((choice) => (
                  <button key={choice.value} type="button" role="radio" aria-checked={choice.value === shown} className="ck-opt ck-acp-more-opt" disabled={off || !!state?.inTerminal} title={choice.description ?? undefined} onClick={() => choice.value !== shown && change(chip.id, choice.value)}>
                    <span className="ck-opt-text">{choice.name}</span>
                    <span className="ck-opt-check" aria-hidden="true">{choice.value === shown ? '✓' : ''}</span>
                  </button>
                ))}
              </div>
            );
          })}
        </Popover>
      )}
      <div className="ck-acp-chips-row" role="group" aria-label={t('r9.chips.group')}>
        {permissionFirst(chips).map((chip) => {
          const shown = picked[chip.id] ?? chip.value;
          const choice = chip.choices.find((c) => c.value === shown);
          const valueName = choice?.name ?? shown;
          // Say what each chip sets: the kind of setting (by ACP category) and the value, plus what the agent says about the value.
          const kind = chip.category === 'mode' ? t('pane.chipPermissions') : chip.category === 'model' ? t('pane.chipModel') : chip.category === 'thought_level' ? t('pane.chipEffort') : chip.label;
          const hint = `${kind}: ${valueName}${choice?.description ? ` - ${choice.description}` : ''}${denied ? ` - ${denied}` : ''}`;
          const known = chip.category === 'mode' || chip.category === 'model' || chip.category === 'thought_level';
          const props = {
            chipId: chip.id,
            label: chip.label,
            hint,
            // A setting of some other kind shows its name before the value, so "Default" is never a mystery.
            caption: known ? undefined : chip.label,
            value: shown,
            choices: chip.choices,
            disabled: off,
            searchable: chip.category === 'model',
            onChange: (value: string) => change(chip.id, value),
          };
          // The permission chip: neutral for the safe modes, warning-yellow with a shield only for Full access. It changes
          // through the same setConfig as before; for a conversation open in a terminal it is plain text.
          if (isPermissionChip(chip)) {
            // The risk is judged on the agent's own wording, not the translated one.
            const full = isFullAccessMode(original.find((c) => c.id === chip.id)?.choices.find((c) => c.value === shown) ?? { value: shown, name: shown });
            return <ChipMenu key={chip.id} {...props} tone={full ? 'risk' : undefined} readOnly={!!state?.inTerminal} />;
          }
          // The effort-like setting (ACP category `thought_level`) with a few choices reads best side by side.
          return chip.category === 'thought_level' && chip.choices.length <= SEGMENTED_MAX ? <ChipSegmented key={chip.id} {...props} /> : <ChipMenu key={chip.id} {...props} />;
        })}
      </div>
      {error && (
        <p className="ck-acp-chips-note" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
