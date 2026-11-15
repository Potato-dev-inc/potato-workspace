import { useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n';
import { errorSentence } from '../../lib/sayError';
import type { MineView, ShelfApi } from '../../lib/shelf';
import { ShelfAddSheet } from './ShelfAddSheet';
import { MineRow, RecommendedCard, SuggestedCard } from './ShelfCards';
import { ShelfSuggestSheet } from './ShelfSuggestSheet';
import { kindMatches, SHELF_FILTERS, subjectOfCard, subjectOfRecommended, type AddSubject, type ShelfFilter } from './shelf-model';
import type { ShelfHandle } from './useShelf';
import { EmptyState } from '../common/EmptyState';

type Sheet = { kind: 'suggest'; item: MineView; installLine?: string } | { kind: 'add'; subject: AddSubject } | null;

/**
 * Shelf: the skills and tools this PC has, what teammates suggest, and what the team recommends. Adding is always
 * look first (the Add sheet shows exactly what is written), then one click. Nothing is added or run by itself.
 */
export function ShelfTab({ shelf, api, onInvite }: { shelf: ShelfHandle; api: ShelfApi; /** "Invite a teammate" in the empty block; absent: no button. */ onInvite?: () => void }) {
  const t = useT();
  const { state, loaded, reload } = shelf;
  const [filter, setFilter] = useState<ShelfFilter>('all');
  const [sheet, setSheet] = useState<Sheet>(null);
  const [error, setError] = useState<string | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (sheet) sheetRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [sheet]);

  if (!state) {
    return (
      <section className="tpg-card" data-testid="shelf-unavailable">
        <h3 className="tpg-h">{t('teamHub.shelf.title')}</h3>
        <p className="tpg-sub">{loaded ? t('teamHub.shelf.unavailable') : t('teamHub.loading')}</p>
      </section>
    );
  }

  const dismiss = (cardId: string) => {
    setError(null);
    api
      .dismiss(cardId)
      .catch((err) => setError(errorSentence(err) || t('teamHub.shelf.dismissFailed')))
      .finally(reload);
  };
  const close = () => setSheet(null);
  const suggested = state.suggested.filter((c) => kindMatches(c.kind, filter));
  const recommended = state.recommended.filter((r) => kindMatches(r.kind, filter));
  const mine = state.mine.filter((m) => kindMatches(m.kind, filter));
  // Nothing at all (not only nothing for this filter): one block, one next step, nothing else to read.
  const nothing = state.suggested.length === 0 && state.recommended.length === 0 && state.mine.length === 0;

  return (
    <div className="tpg-shelf" data-testid="shelf-tab">
      <div>
        <h3 className="tpg-h">{t('teamHub.shelf.title')}</h3>
        <p className="tpg-sub">{t('teamHub.shelf.intro')}</p>
      </div>
      {nothing ? (
        <EmptyState
          testId="shelf-empty"
          className="tpg-empty-block"
          title={t('teamHub.shelf.emptyTitle')}
          line={t('teamHub.shelf.emptyLine')}
          action={onInvite ? { label: t('teamHub.inviteTeammate'), onClick: onInvite } : null}
        />
      ) : (
        <>
          <div className="tpg-filters" role="group" aria-label={t('teamHub.shelf.filters')}>
            {SHELF_FILTERS.map((f) => (
              <button key={f} type="button" className="tpg-filter" aria-pressed={filter === f} onClick={() => setFilter(f)}>
                {t(`teamHub.shelf.filter.${f}` as const)}
              </button>
            ))}
          </div>
          {error && (
            <p className="tpg-error" role="alert">
              {error}
            </p>
          )}
          <div ref={sheetRef}>
            {sheet?.kind === 'suggest' && <ShelfSuggestSheet key={sheet.item.id} item={sheet.item} installLine={sheet.installLine} people={state.people} api={api} onClose={close} onSent={reload} />}
            {sheet?.kind === 'add' && <ShelfAddSheet key={sheet.subject.cardId} subject={sheet.subject} targets={state.targets} api={api} onClose={close} onChanged={reload} />}
          </div>

          {suggested.length > 0 && (
            <section aria-label={t('teamHub.shelf.block.suggested')} data-testid="shelf-block-suggested">
              <h3 className="tpg-h">{t('teamHub.shelf.block.suggested')}</h3>
              <ul className="ib-list tpg-shelf-list">
                {suggested.map((c) => (
                  <SuggestedCard key={c.cardId} card={c} teamSize={state.teamSize} onLook={() => setSheet({ kind: 'add', subject: subjectOfCard(c) })} onDismiss={() => dismiss(c.cardId)} />
                ))}
              </ul>
            </section>
          )}

          {recommended.length > 0 && (
            <section aria-label={t('teamHub.shelf.block.recommended')} data-testid="shelf-block-recommended">
              <h3 className="tpg-h">{t('teamHub.shelf.block.recommended')}</h3>
              <ul className="ib-list tpg-shelf-list">
                {recommended.map((r) => (
                  <RecommendedCard key={r.cardId} rec={r} teamSize={state.teamSize} onAdd={() => setSheet({ kind: 'add', subject: subjectOfRecommended(r) })} />
                ))}
              </ul>
            </section>
          )}

          <section aria-label={t('teamHub.shelf.block.mine')} data-testid="shelf-block-mine">
            <h3 className="tpg-h">{t('teamHub.shelf.block.mine')}</h3>
            {mine.length === 0 ? (
              <p className="tpg-sub tpg-empty" data-testid="shelf-mine-empty">
                {t('teamHub.shelf.mine.empty')}
              </p>
            ) : (
              <ul className="ib-list tpg-shelf-list">
                {mine.map((m) => (
                  <MineRow
                    key={m.id}
                    item={m}
                    teamSize={state.teamSize}
                    onSuggest={() => setSheet({ kind: 'suggest', item: m })}
                    // The install line has its own id: that is what is sent, never the tool that runs from a folder here.
                    onSuggestInstall={m.install ? () => setSheet({ kind: 'suggest', item: { ...m, id: m.install!.id }, installLine: m.install!.shown }) : undefined}
                  />
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
