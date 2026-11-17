// A full-screen card for a push tap on an item that has no pane to open (an agent's question, a consent
// request), or on one the list no longer holds. It draws the same cards as the Needs you list.
import { useEffect, useRef, useState } from 'react';
import type { AttentionItem, AttentionSnapshot } from '../../lib/attention';
import { COPY, isRiskyAsk } from '../../lib/attention-copy';
import { useT } from '../../i18n';
import type { BridgeClient } from '../../lib/bridge-types';
import { PROMPT_KINDS, QUESTION_KINDS, isOpen, subjectOf } from '../../lib/needs-you-queue';
import type { Question } from '../../lib/questions';
import { ApprovalCard } from './ApprovalCard';
import '../../styles/phone-ask.css';
import { Sheet } from './MobileSheet';
import { NoteCard } from './NeedsYouList';
import { QuestionsView } from './QuestionsList';

/** The risky ask: the whole screen, its own layer. It slides up (a fade under reduced motion); "Decide later" or Escape leaves the ask waiting. */
function FullCard({ item, bridge, canAnswer, onClose, onOpenPane, onRefresh }: { item: AttentionItem; bridge: BridgeClient; canAnswer: boolean; onClose: () => void; onOpenPane: (paneId: string) => void; onRefresh?: () => void }) {
  const t = useT();
  const layer = useRef<HTMLDivElement>(null);
  const closeTimer = useRef(0);
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.clearTimeout(closeTimer.current);
      before?.focus?.({ preventScroll: true });
    };
  }, [onClose]);
  return (
    <div className="ph-full" ref={layer} role="dialog" aria-modal="true" aria-label={item.pane?.heading ?? t('phone.needsYou')} data-testid="card-sheet" data-full="true">
      <button type="button" className="ph-full-later" onClick={onClose}>
        {t('phone.full.close')}
      </button>
      <ApprovalCard
        item={item}
        bridge={bridge}
        canAnswer={canAnswer}
        variant="full"
        autoFocus
        onOpenPane={onOpenPane}
        onRefresh={onRefresh}
        onAnswered={() => {
          // The answer shows for a moment ("Allowed once ..."), then the card slides away.
          window.clearTimeout(closeTimer.current);
          closeTimer.current = window.setTimeout(onClose, 900);
        }}
      />
    </div>
  );
}

export function CardSheet({
  item,
  snapshot,
  bridge,
  canAnswer,
  labels,
  onClose,
  onOpenPane,
  onRefresh,
}: {
  item: AttentionItem;
  snapshot: AttentionSnapshot;
  bridge: BridgeClient;
  canAnswer: boolean;
  labels: Map<string, string>;
  onClose: () => void;
  onOpenPane: (paneId: string) => void;
  onRefresh?: () => void;
}) {
  const [questions, setQuestions] = useState<Question[]>([]);
  const isQuestion = QUESTION_KINDS.includes(item.kind);
  const refresh = () => {
    bridge
      .listQuestions()
      .then(setQuestions)
      .catch(() => {});
  };
  useEffect(() => {
    if (isQuestion) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  // The item as the list holds it now (a card opened from a tap keeps up with the PC).
  const live = snapshot.items.find((i) => i.id === item.id) ?? item;
  const question = isQuestion ? questions.find((q) => q.id === subjectOf(live)) : undefined;
  // Opened as a risky ask: it stays the full card until it is answered, then settles.
  if (isRiskyAsk(item)) {
    return <FullCard item={live} bridge={bridge} canAnswer={canAnswer} onClose={onClose} onOpenPane={onOpenPane} onRefresh={onRefresh} />;
  }
  return (
    <Sheet title={live.pane?.heading ?? 'Needs you'} onClose={onClose}>
      <div className="ph-sheet-card" data-testid="card-sheet">
        {PROMPT_KINDS.includes(live.kind) && (
          <ApprovalCard item={live} bridge={bridge} canAnswer={canAnswer} onOpenPane={onOpenPane} onRefresh={onRefresh} autoFocus />
        )}
        {isQuestion && isOpen(live) && question && (
          <QuestionsView bridge={bridge} questions={[question]} refresh={refresh} labels={labels} bare readOnly={canAnswer ? undefined : COPY.watchOnly} />
        )}
        {isQuestion && !isOpen(live) && <NoteCard item={{ ...live, sentence: live.resolution?.state === 'answered' ? `Answered${live.resolution.choice_label ? `: ${live.resolution.choice_label}` : ''}.` : COPY.dealtWith }} onOpenPane={onOpenPane} />}
        {!PROMPT_KINDS.includes(live.kind) && !isQuestion && <NoteCard item={live} onOpenPane={onOpenPane} />}
      </div>
    </Sheet>
  );
}
