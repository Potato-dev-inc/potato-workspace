// The agent's own settings (model, mode, effort) on the footer line of the message box of a chat session. One control per
// setting the agent offers (a pop-up menu, or a compact Low/Medium/High switch for the effort-like setting when it has
// four choices or fewer); nothing is drawn when it offers none. Settings change between turns, so the controls are
// switched off while the agent works (and when the conversation is open in a terminal).
import { useEffect, useState } from 'react';
import { chipsDisabled, configChips, errorSentence, tauriAcpChatApi, type AcpChatApi, type AcpChatState } from '../../lib/acpChat';
import { ChipMenu, ChipSegmented } from './ChipMenu';
import '../../styles/cockpit-acp.css';

/** An effort-like setting with this many choices or fewer is drawn as a segmented switch. */
const SEGMENTED_MAX = 4;

export function AcpConfigChips({ paneId, state, api = tauriAcpChatApi }: { paneId: string; state: AcpChatState | null; api?: Pick<AcpChatApi, 'setConfig'> }) {
  // A pick shows at once; the backend's state replaces it when it arrives, and a refusal takes it back.
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setPicked({});
    setError(null);
  }, [state?.configOptions, paneId]);

  const chips = configChips(state);
  if (chips.length === 0) return null;
  const off = chipsDisabled(state);
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
    <div className="ck-acp-chips" data-testid="acp-chips">
      <div className="ck-acp-chips-row" role="group" aria-label="Chat settings">
        {chips.map((chip) => {
          const props = {
            chipId: chip.id,
            label: chip.label,
            value: picked[chip.id] ?? chip.value,
            choices: chip.choices,
            disabled: off,
            onChange: (value: string) => change(chip.id, value),
          };
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
