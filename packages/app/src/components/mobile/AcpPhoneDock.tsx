// What a chat session over ACP adds under its conversation on the phone: the agent's permission questions as cards
// (every option with the agent's own name, no default) and, while a turn runs, a line that says so. Stop is the message box's own round button, never a second one here.
// No settings chips, no slash menu and no hand-over here: those are for the PC.
import { useEffect, useMemo, useState } from 'react';
import { useT } from '../../i18n';
import { useAcpPhoneState } from '../../hooks/useAcpPhoneState';
import { driveStrip, permissionCards, runStrip } from '../../lib/acpChat';
import type { BridgeClient } from '../../lib/bridge';
import { COPY } from '../../lib/attention-copy';
import { QuestionsView, useQuestionPolling } from './QuestionsList';
import '../../styles/phone-chat.css';

export function AcpPhoneDock({
  bridge,
  paneId,
  canAnswer,
  canType = false,
  labels,
  questionsRevision = 0,
}: {
  bridge: BridgeClient;
  paneId: string;
  /** This phone may answer the agent's questions (`answer`). */
  canAnswer: boolean;
  /** This phone may type (`type`): the "take it back" button needs it. The stop button lives in the message box. */
  canType?: boolean;
  labels: Map<string, string>;
  /** Bumped by the bridge `questions` event; a change reads the questions again. */
  questionsRevision?: number;
}) {
  const t = useT();
  const state = useAcpPhoneState(bridge, paneId, true);
  const { questions, refresh } = useQuestionPolling(bridge, true, questionsRevision);

  // Which device this phone is, so its own typing is not shown back to it.
  const [selfId, setSelfId] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    bridge.pairMe?.().then((me) => live && setSelfId(me.device_id ?? null)).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [bridge]);
  // The PC took this chat back, or another device is typing / driving here.
  const tookBack = state && !state.closed ? state.drive?.took_back ?? null : null;
  const stateAt = useMemo(() => Date.now(), [state]);
  const [now, setNow] = useState(() => Date.now());
  const other = driveStrip(state, now, stateAt);
  const otherNote = other && other.id !== selfId && !tookBack ? other : null;
  const typingUntil = otherNote?.until ?? null;
  useEffect(() => {
    if (typingUntil === null) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, typingUntil - Date.now()) + 50);
    return () => window.clearTimeout(timer);
  }, [typingUntil]);
  const [taking, setTaking] = useState(false);
  const [takeError, setTakeError] = useState<string | null>(null);
  const takeOver = () => {
    if (!bridge.acpClaim || taking) return;
    setTaking(true);
    setTakeError(null);
    bridge
      .acpClaim(paneId)
      .catch(() => setTakeError(t('drive.takeOverFailed')))
      .finally(() => setTaking(false));
  };

  const cards = permissionCards(questions, paneId);
  const strip = runStrip(state, false);
  if (cards.length === 0 && !strip && !tookBack && !otherNote) return null;

  return (
    <div className="ph-acp-dock" data-testid="acp-phone-dock">
      {cards.length > 0 && <QuestionsView bridge={bridge} questions={cards} refresh={refresh} labels={labels} bare readOnly={canAnswer ? undefined : COPY.watchOnly} />}
      {strip && (
        <div className="ph-acp-strip" data-testid="acp-phone-strip">
          <span role="status">{strip.waking ? t('chat.waking') : strip.text}</span>
        </div>
      )}
      {tookBack && (
        <div className="ph-drive-note" data-testid="phone-took-back">
          <span role="status">{takeError ?? t('drive.tookBack', { name: tookBack.by_name })}</span>
          {canType && bridge.acpClaim && (
            <button type="button" className="ph-btn" onClick={takeOver} disabled={taking}>
              {t('drive.takeOver')}
            </button>
          )}
        </div>
      )}
      {otherNote && (
        <div className="ph-drive-note" data-testid="phone-drive-note">
          <span role="status">{otherNote.text}</span>
        </div>
      )}
    </div>
  );
}
