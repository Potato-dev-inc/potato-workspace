// The pill in the phone's message box that opens the agent's own settings: model, mode, effort, and any other setting the
// agent sends. The list is the one the desktop's chips use (`configChips` over `GET /acp/sessions/{pane}`); a pick calls
// `POST /acp/sessions/{pane}/config`, the same path as the desktop. Settings change between turns, so they are switched off
// while the agent works. A mode that lets the agent act without asking shows the yellow shield and needs a press and hold.
import { useEffect, useState } from 'react';
import { useT } from '../../i18n';
import { useAcpPhoneState } from '../../hooks/useAcpPhoneState';
import { chipsDisabled, configChips, type ConfigChip } from '../../lib/acpChat';
import type { BridgeClient } from '../../lib/bridge-types';
import { errorSentence } from '../../lib/sayError';
import { isFullAccessMode, isPermissionChip, permissionFirst } from '../chat/permissionChip';
import { HoldButton } from './HoldButton';
import { Sheet } from './MobileSheet';
import '../../styles/phone-pick.css';

function Shield() {
  return (
    <svg className="ph-pick-shield" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6z" />
      <path d="M12 8v5M12 16v.5" />
    </svg>
  );
}

/**
 * A name a person can read. The agent's own name for the choice when it differs from the raw id; otherwise the id cleaned up:
 * the part before "/" dropped, dashes and underscores to spaces ("opencode-go/deepseek-v3" -> "deepseek v3").
 */
export function friendlyName(name: string, value: string): string {
  const raw = name.trim() === '' ? value : name;
  if (raw !== value && !raw.includes('/')) return raw;
  const tail = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw;
  const spaced = tail.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return spaced === '' ? raw : spaced;
}

/** The heading of one setting: the kind in plain words when ACP says which kind it is, else the agent's own name for it. */
function kindOf(chip: ConfigChip, t: ReturnType<typeof useT>): string {
  if (chip.category === 'model') return t('phone.pick.model');
  if (chip.category === 'mode') return t('phone.pick.mode');
  if (chip.category === 'thought_level') return t('phone.pick.effort');
  return chip.label;
}

export function PhonePicker({
  bridge,
  paneId,
  canControl,
  fallbackLabel,
}: {
  bridge: BridgeClient;
  paneId: string;
  /** This phone may change the agent's settings (`control`). */
  canControl: boolean;
  /** The label shown while the agent's settings are not known (the model the conversation says it runs). */
  fallbackLabel: string;
}) {
  const t = useT();
  const state = useAcpPhoneState(bridge, paneId, true);
  const [open, setOpen] = useState(false);
  /** A pick shows at once; the PC's state replaces it, a refusal takes it back. */
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  /** A full-access choice waits here for the press and hold. */
  const [holdFor, setHoldFor] = useState<{ chip: string; value: string } | null>(null);
  // Every poll brings a fresh copy of the settings: only a real change (by content) clears a pick that waits for the PC's state.
  const settingsKey = JSON.stringify(state?.configOptions ?? null);
  useEffect(() => {
    setPicked({});
    setError(null);
    setHoldFor(null);
  }, [settingsKey, paneId]);

  const chips = permissionFirst(configChips(state));
  const model = chips.find((c) => c.category === 'model');
  const shown = (chip: ConfigChip) => picked[chip.id] ?? chip.value;
  const nameOf = (chip: ConfigChip) => {
    const value = shown(chip);
    return friendlyName(chip.choices.find((c) => c.value === value)?.name ?? value, value);
  };
  const modeChip = chips.find((c) => c.category === 'mode');
  const pill = model ? [nameOf(model), modeChip ? nameOf(modeChip) : null].filter(Boolean).join(' · ') : (chips[0] ? nameOf(chips[0]) : fallbackLabel);
  const off = chipsDisabled(state);

  const apply = (chip: ConfigChip, value: string, hold: boolean) => {
    if (!bridge.acpSetConfig) return;
    setError(null);
    setHoldFor(null);
    setPicked((cur) => ({ ...cur, [chip.id]: value }));
    bridge.acpSetConfig(paneId, chip.id, value, hold).catch((e: unknown) => {
      setPicked((cur) => {
        const { [chip.id]: _gone, ...rest } = cur;
        return rest;
      });
      setError(/ -> 403/.test(errorSentence(e)) ? t('phone.pick.refused') : t('phone.pick.failed'));
    });
  };
  const choose = (chip: ConfigChip, value: string) => {
    if (off || !canControl || value === shown(chip)) return;
    const choice = chip.choices.find((c) => c.value === value);
    if (isPermissionChip(chip) && isFullAccessMode(choice ?? { value, name: value })) {
      setHoldFor({ chip: chip.id, value });
      return;
    }
    apply(chip, value, false);
  };

  return (
    <>
      <button type="button" className="ph-comp-model ph-pick-pill" data-testid="phone-pick-pill" aria-haspopup="dialog" aria-label={`${t('phone.pick.open')}: ${pill}`} onClick={() => setOpen(true)}>
        <span>{pill}</span>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m7 10 5 5 5-5" />
        </svg>
      </button>
      {open && (
        <Sheet title={t('phone.pick.title')} onClose={() => setOpen(false)}>
          <div className="ph-pick" data-testid="phone-pick-sheet">
            {chips.length === 0 && <p className="ph-pick-note">{t('phone.pick.none')}</p>}
            {chips.length > 0 && off && <p className="ph-pick-note">{t('phone.pick.busy')}</p>}
            {chips.length > 0 && !canControl && <p className="ph-pick-note">{t('phone.pick.noControl')}</p>}
            {chips.map((chip) => (
              <section key={chip.id} className="ph-pick-sec" aria-label={kindOf(chip, t)}>
                <h3>{kindOf(chip, t)}</h3>
                <div role="radiogroup" aria-label={kindOf(chip, t)}>
                  {chip.choices.map((choice) => {
                    const on = choice.value === shown(chip);
                    const full = isPermissionChip(chip) && isFullAccessMode(choice);
                    return (
                      <button
                        key={choice.value}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        className="ph-pick-opt"
                        data-risk={full || undefined}
                        data-on={on || undefined}
                        disabled={off || !canControl}
                        onClick={() => choose(chip, choice.value)}
                      >
                        {full && <Shield />}
                        <span className="ph-pick-txt">
                          <span className="ph-pick-name">{chip.category === 'model' ? friendlyName(choice.name, choice.value) : choice.name}</span>
                          {choice.description && <span className="ph-pick-desc">{choice.description}</span>}
                          {full && <span className="ph-pick-desc">{t('phone.pick.fullWarn')}</span>}
                        </span>
                        {on && (
                          <svg className="ph-pick-tick" viewBox="0 0 24 24" role="img" aria-label={t('phone.pick.current')}>
                            <path d="m5 12.5 4.5 4.5L19 7.5" />
                          </svg>
                        )}
                      </button>
                    );
                  })}
                </div>
                {chip.category === 'model' && (
                  <p className="ph-pick-raw" data-testid="phone-pick-raw">
                    {shown(chip)}
                  </p>
                )}
                {holdFor?.chip === chip.id && (
                  <HoldButton className="ph-pick-hold" label={t('phone.pick.holdFull')} onDone={() => apply(chip, holdFor.value, true)} />
                )}
              </section>
            ))}
            {error && (
              <p className="ph-pick-note ph-pick-note--err" role="alert">
                {error}
              </p>
            )}
          </div>
        </Sheet>
      )}
    </>
  );
}

