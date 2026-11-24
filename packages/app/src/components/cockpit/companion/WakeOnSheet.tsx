// "Wake {name} on…": the sheet a usage-limit card opens for a companion's pane. The agent ran out, so the companion can
// run on another one the person has; "until" is filled with the time the limit ends, so it goes back by itself.
import { useEffect, useState } from 'react';
import type { CompanionAgentOption, CompanionTransport, CompanionView } from '../../../lib/companion';
import { Sheet } from '../Sheet';
import { MovePicker } from './MovePicker';
import { t } from '../../../i18n';

export function WakeOnSheet({
  companion,
  transport,
  resetAtMs,
  onClose,
  now = Date.now,
}: {
  companion: CompanionView;
  transport: Pick<CompanionTransport, 'agents' | 'update'>;
  /** When the limit ends (epoch ms), when the card knows. */
  resetAtMs?: number;
  onClose: () => void;
  now?: () => number;
}) {
  const [agents, setAgents] = useState<CompanionAgentOption[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    transport
      .agents()
      .then((list) => live && setAgents(list))
      .catch(() => live && setAgents([]));
    return () => {
      live = false;
    };
  }, [transport]);

  const firstOk = (agents ?? []).find((a) => a.id !== companion.agentType && a.ok);
  const later = resetAtMs && resetAtMs > now() ? resetAtMs : null;

  const move = async (agentType: string, untilMs: number | null) => {
    setBusy(true);
    setError(null);
    try {
      await transport.update(companion.id, { agentType, untilMs });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not move it.');
      setBusy(false);
    }
  };

  return (
    <Sheet onClose={busy ? undefined : onClose} labelledBy="ck-wake-on-title" className="ck-companion-sheet" role="dialog">
      <h3 className="ck-section" id="ck-wake-on-title">
        Wake {companion.name} on…
      </h3>
      <p className="ck-sub">{t('r21.sw.sameNameFaceAnd')}</p>
      {agents === null ? (
        <p className="ck-sub">{t('r21.sw.lookingAtYourAgents')}</p>
      ) : firstOk ? (
        <MovePicker
          currentAgent={companion.agentType}
          agents={agents}
          initialAgent={firstOk.id}
          defaultUntilMs={later}
          submitLabel={`Wake ${companion.name}`}
          busy={busy}
          now={now}
          onMove={(agentType, untilMs) => void move(agentType, untilMs)}
        />
      ) : (
        <p className="ck-sub">{t('r21.sw.noOtherAgentCan')}</p>
      )}
      {error && (
        <p className="ck-memory-msg ck-memory-err" role="alert">
          {error}
        </p>
      )}
      <div className="ck-sheet-actions">
        <button type="button" className="ck-btn ck-btn--plain" onClick={onClose} disabled={busy}>
          Cancel
        </button>
      </div>
    </Sheet>
  );
}
