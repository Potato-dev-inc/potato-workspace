// The Needs you queue on the phone's Agents screen: one card per blocking item, in the PC's order
// (high risk and consent first, then oldest first). It is the PC's one attention list drawn as cards,
// so it can never show a different number than the counter above it. An approval or a folder-trust
// question is answered here (`ApprovalCard`); an `ask_user` question, a consent request, a spent
// budget and a usage limit keep their own cards (`QuestionsView`); anything else says what happened
// and offers its pane. Nothing is dropped: a card leaves only when the PC resolves it.
import { useCallback, useEffect, useState } from 'react';
import type { AttentionItem, AttentionSnapshot } from '../../lib/attention';
import { COPY, isRiskyAsk } from '../../lib/attention-copy';
import { useT } from '../../i18n';
import { RiskGlyph } from '../cockpit/InboxCard';
import type { BridgeClient } from '../../lib/bridge-types';
import { PROMPT_KINDS, QUESTION_KINDS, isOpen, subjectOf, visibleQueue } from '../../lib/needs-you-queue';
import type { Question } from '../../lib/questions';
import { useHeldItems } from '../../hooks/useHeldItems';
import { DotSpinner } from '../cockpit/DotSpinner';
import { ApprovalCard } from './ApprovalCard';
import { QuestionsView } from './QuestionsList';
import '../../styles/mobile-approval.css';

/** A card for an item with nothing to answer: an error, a stuck agent, a warning. */
export function NoteCard({ item, onOpenPane }: { item: AttentionItem; onOpenPane?: (paneId: string) => void }) {
  const paneId = item.pane?.id;
  return (
    <article className="ph-appr ph-appr--none ph-appr--note" data-item-kind={item.kind} data-card-state="note" aria-label={item.title}>
      <header className="ph-appr-head">
        <span className="ph-appr-glyph">
          <DotSpinner status={item.kind === 'error' ? 'error' : 'waiting_input'} />
        </span>
        <span className="ph-appr-pane">{item.pane?.heading ?? item.pane?.agent ?? 'Agent'}</span>
      </header>
      <div className="ph-appr-risk">
        <span className="ph-appr-title">{item.title}</span>
      </div>
      {item.sentence && <p className="ph-appr-status">{item.sentence}</p>}
      {paneId && onOpenPane && (
        <div className="ph-appr-actions">
          <button type="button" className="ph-btn ph-btn--plain" onClick={() => onOpenPane(paneId)}>
            {COPY.openPane}
          </button>
        </div>
      )}
    </article>
  );
}

/** A risky ask as one line: who, what, how risky. It carries no command; a tap opens the full card. */
export function RiskyAskRow({ item, onOpen, compact = false }: { item: AttentionItem; onOpen: (item: AttentionItem) => void; compact?: boolean }) {
  const t = useT();
  const level = item.risk?.level ?? 'medium';
  const title = item.risk?.headline?.trim() || item.title;
  return (
    <button type="button" className={`ph-risky-row ph-risky-row--${level}${compact ? ' ph-risky-row--dock' : ''}`} data-testid="risky-row" data-item-kind={item.kind} aria-label={t('phone.full.rowLabel', { title })} onClick={() => onOpen(item)}>
      <span className="ph-risky-row-glyph" aria-hidden="true">
        <RiskGlyph level={level} />
      </span>
      <span className="ph-risky-row-text">
        <b>{item.pane?.heading ?? item.pane?.agent ?? t('phone.full.review')}</b>
        <span>{title}</span>
      </span>
      <span className="ph-risky-row-go">{t('phone.full.review')}</span>
    </button>
  );
}

export function NeedsYouList({
  snapshot,
  bridge,
  canAnswer,
  questions,
  refreshQuestions,
  labels,
  onOpenPane,
  onRefresh,
  onOpenCard,
  showEmpty = false,
  emptyText,
}: {
  snapshot: AttentionSnapshot;
  bridge: BridgeClient;
  canAnswer: boolean;
  /** The agents' pending questions (`GET /questions`): the choices and text of the question-like cards. */
  questions: Question[];
  refreshQuestions: () => void;
  labels: Map<string, string>;
  onOpenPane: (paneId: string) => void;
  /** An answer came back stale: read the PC's list again. */
  onRefresh?: () => void;
  /** A risky ask is one line that opens its full card here (the phone home). Without it the card is drawn in the list. */
  onOpenCard?: (item: AttentionItem) => void;
  /** Draw "Nothing needs you" when the queue is empty. */
  showEmpty?: boolean;
  /** The empty state in other words (the phone home says "Nothing needs you right now."). */
  emptyText?: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  // Answers this phone gave (item id -> when): the tombstone of such a card leaves 3 s later.
  const [own, setOwn] = useState<ReadonlyMap<string, number>>(() => new Map());
  const markOwn = useCallback((id: string) => setOwn((prev) => (prev.has(id) ? prev : new Map(prev).set(id, Date.now()))), []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const queue = useHeldItems(visibleQueue(snapshot, own, now));
  const canControl = snapshot.device?.can_control ?? true;

  if (queue.length === 0) {
    return showEmpty ? (
      emptyText ? (
        <div className="ph-queue-empty" data-testid="needs-you-empty">
          <b>{emptyText}</b>
        </div>
      ) : (
        <div className="ph-queue-empty">
          <b>{COPY.empty.title}</b>
          {COPY.empty.body}
        </div>
      )
    ) : null;
  }

  const byId = new Map(questions.map((q) => [q.id, q]));
  return (
    <section aria-label="Needs you" className="ph-queue" data-testid="needs-you-queue">
      {queue.map((item) => {
        if (onOpenCard && isRiskyAsk(item)) return <RiskyAskRow key={item.id} item={item} onOpen={onOpenCard} />;
        if (PROMPT_KINDS.includes(item.kind)) {
          return (
            <ApprovalCard
              key={item.id}
              item={item}
              bridge={bridge}
              canAnswer={canAnswer}
              onOpenPane={onOpenPane}
              onAnswered={() => markOwn(item.id)}
              onRefresh={onRefresh}
            />
          );
        }
        if (QUESTION_KINDS.includes(item.kind) && isOpen(item)) {
          const q = byId.get(subjectOf(item));
          if (q) {
            // Budget and usage-limit cards spend or stop a run: without `control` the phone only reads them.
            const readOnly = !canAnswer ? COPY.watchOnly : (item.kind === 'budget' || item.kind === 'limit') && !canControl ? COPY.controlOnly : undefined;
            return (
              <div key={item.id} className="ph-qwrap" data-item-kind={item.kind}>
                <QuestionsView bridge={bridge} questions={[q]} refresh={refreshQuestions} labels={labels} bare readOnly={readOnly} />
              </div>
            );
          }
        }
        return <NoteCard key={item.id} item={item} onOpenPane={onOpenPane} />;
      })}
    </section>
  );
}
